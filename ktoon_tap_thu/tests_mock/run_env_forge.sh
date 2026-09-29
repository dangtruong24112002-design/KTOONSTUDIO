#!/bin/bash
# Start the mock providers (port 9220) and a throwaway copy of forge (port 8945) for tests.
# usage: bash run_env_forge.sh [budget]   (run from anywhere; Linux/macOS)
HERE="$(cd "$(dirname "$0")" && pwd)"; APP="$HERE/../../forge"; RUN="$HERE/run_forge"
[ -f "$RUN/app.pid" ] && kill -9 "$(cat "$RUN/app.pid")" 2>/dev/null
[ -f "$HERE/mock_forge.pid" ] && kill -9 "$(cat "$HERE/mock_forge.pid")" 2>/dev/null
for port in 8945 8946 8947 8948 9220 9221 9222; do
  pid=$(fuser -n tcp "$port" 2>/dev/null | awk '{print $1}')
  [ -n "$pid" ] && kill -9 $pid 2>/dev/null
done
sleep 0.5
rm -rf "$RUN" && mkdir -p "$RUN"
cp "$APP/app.py" "$APP/pipeline.py" "$APP/providers.py" "$APP/ui.html" "$RUN/"
printf 'WAVESPEED_API_KEY=test-ws-key-123456\nATLASCLOUD_API_KEY=test-atlas-key-123456\nBUDGET_USD=%s\n' "${1:-40}" > "$RUN/keys.txt"
(cd "$HERE" && nohup python3 mock_providers.py 9220 > mock_forge.out 2>&1 & echo $! > "$HERE/mock_forge.pid")
sleep 0.5
(cd "$RUN" && KTOON_WS_BASE=http://127.0.0.1:9220/ws KTOON_WS_LLM=http://127.0.0.1:9220/llm \
 KTOON_ATLAS_BASE=http://127.0.0.1:9220/atlas KTOON_ATLAS_PUB=http://127.0.0.1:9220/atlaspub \
 KTOON_POLL=0.3 KTOON_NO_BROWSER=1 KTOON_PORT=8945 KTOON_TEST_TOKEN=test-token-forge \
 nohup python3 app.py > app.out 2>&1 & echo $! > "$RUN/app.pid")
sleep 1.2; cat "$RUN/app.out"
