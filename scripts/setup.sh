#!/usr/bin/env bash
# Clones the official Spark for Claude MCP server (MIT) into vendor/ and installs its deps.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p vendor
if [ -d vendor/spark-claude-extension/.git ]; then
  git -C vendor/spark-claude-extension pull --ff-only
else
  git clone --depth 1 https://github.com/readdle/spark-claude-extension.git vendor/spark-claude-extension
fi
( cd vendor/spark-claude-extension && npm install --omit=dev )
if [ ! -f .env ]; then
  echo "SPARK_MCP_TOKEN=$(openssl rand -base64 32 | tr -d '/+=' | head -c 40)" > .env
  echo "PORT=8787" >> .env
  echo "Wrote .env with a fresh SPARK_MCP_TOKEN"
fi
echo "Done. Start with: npm start   (loads .env via node --env-file)"
