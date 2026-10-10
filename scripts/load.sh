#!/usr/bin/env bash
# Sobe a API com banco temporário, roda o k6 (Docker) e verifica a invariante de determinismo no fim.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-3107}"
TMP_DIR=".load-tmp"
mkdir -p "$TMP_DIR"
DB_PATH="$TMP_DIR/load-$(date +%s).db"
export DB_PATH

npx tsx scripts/load-fixtures.ts

PORT="$PORT" DB_PATH="$DB_PATH" NODE_OPTIONS="--disable-warning=ExperimentalWarning" node --import tsx src/index.ts > "$TMP_DIR/server.log" 2>&1 &
SERVER_PID=$!
# Mata só o processo que este script subiu.
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 50); do
  if curl -fs "http://localhost:$PORT/health" > /dev/null; then break; fi
  sleep 0.2
done
curl -fs "http://localhost:$PORT/health" > /dev/null || { echo "API não subiu"; cat "$TMP_DIR/server.log"; exit 1; }

{ printf 'const FIXTURES = '; cat load/fixtures.json; printf ';\n'; cat load/classify.js; } |
  docker run --rm -i --add-host=host.docker.internal:host-gateway \
    -e BASE_URL="http://host.docker.internal:$PORT" grafana/k6:0.54.0 run -

BASE_URL="http://localhost:$PORT" npx tsx scripts/verify-load.ts
