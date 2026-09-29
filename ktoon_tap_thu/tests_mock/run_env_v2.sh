#!/bin/bash
# Start the mock providers (port 9200) and a throwaway copy of tap_thu_v2 (port 8890) for tests.
# usage: bash run_env_v2.sh [budget]   (run from anywhere; Linux/macOS)
HERE="$(cd "$(dirname "$0")" && pwd)"; APP="$HERE/../../tap_thu_v2"; RUN="$HERE/run_v2"
[ -f "$RUN/app.pid" ] && kill -9 "$(cat "$RUN/app.pid")" 2>/dev/null
[ -f "$HERE/mock_v2.pid" ] && kill -9 "$(cat "$HERE/mock_v2.pid")" 2>/dev/null
for port in 8890 8891 8892 8893 8894 9200 9201 9202; do
  pid=$(fuser -n tcp "$port" 2>/dev/null | awk '{print $1}')
  [ -n "$pid" ] && kill -9 $pid 2>/dev/null
done
sleep 0.5
rm -rf "$RUN" && mkdir -p "$RUN"
cp "$APP/app.py" "$APP/pipeline.py" "$APP/providers.py" "$APP/ui.html" "$RUN/"
printf 'WAVESPEED_API_KEY=test-ws-key-123456\nATLASCLOUD_API_KEY=test-atlas-key-123456\nBUDGET_USD=%s\nDATA_DIR=%s/data\n' "${1:-30}" "$RUN" > "$RUN/keys.txt"
(cd "$HERE" && nohup python3 mock_providers.py 9200 > mock_v2.out 2>&1 & echo $! > "$HERE/mock_v2.pid")
sleep 0.5
(cd "$RUN" && KTOON_WS_BASE=http://127.0.0.1:9200/ws KTOON_WS_LLM=http://127.0.0.1:9200/llm \
 KTOON_ATLAS_BASE=http://127.0.0.1:9200/atlas KTOON_ATLAS_PUB=http://127.0.0.1:9200/atlaspub \
 KTOON_POLL=0.3 KTOON_MEASURE_WAIT=0.3 KTOON_NO_BROWSER=1 KTOON_PORT=8890 KTOON_TEST_TOKEN=test-token-v2 \
 nohup python3 app.py > app.out 2>&1 & echo $! > "$RUN/app.pid")
sleep 1.2; cat "$RUN/app.out"
