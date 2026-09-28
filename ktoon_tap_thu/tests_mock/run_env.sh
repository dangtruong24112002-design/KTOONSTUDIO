#!/bin/bash
# Start the mock providers (port 9100) and a throwaway copy of the v1 app (port 8790) for tests.
# usage: bash run_env.sh [budget]   (run from anywhere; Linux/macOS)
HERE="$(cd "$(dirname "$0")" && pwd)"; APP="$HERE/../ktoon_tap_thu"; RUN="$HERE/run_v1"
pkill -f "[r]un_v1/app.py" 2>/dev/null; pkill -f "[m]ock_providers.py 9100" 2>/dev/null; sleep 0.5
rm -rf "$RUN" && mkdir -p "$RUN" && cp "$APP/app.py" "$APP/ui.html" "$RUN/"
printf 'WAVESPEED_API_KEY=test-ws-key-123456\nATLASCLOUD_API_KEY=test-atlas-key-123456\nBUDGET_USD=%s\n' "${1:-20}" > "$RUN/keys.txt"
(cd "$HERE" && nohup python3 mock_providers.py 9100 > mock.out 2>&1 &)
sleep 0.5
(cd "$RUN" && KTOON_WS_BASE=http://127.0.0.1:9100/ws KTOON_WS_LLM=http://127.0.0.1:9100/llm \
 KTOON_ATLAS_BASE=http://127.0.0.1:9100/atlas KTOON_ATLAS_PUB=http://127.0.0.1:9100/atlaspub \
 KTOON_POLL_FAST=0.3 KTOON_POLL_SLOW=0.5 KTOON_MEASURE_WAIT=0.3 KTOON_NO_BROWSER=1 KTOON_PORT=8790 \
 nohup python3 app.py > app.out 2>&1 &)
sleep 1.2; cat "$RUN/app.out"
