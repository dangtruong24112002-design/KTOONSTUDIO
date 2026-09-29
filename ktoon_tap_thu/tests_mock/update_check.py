"""Checks for the self-updater (docs/SPEC_TAP_THU_V2.md §18, yêu cầu #6), against the fake GitHub API in
mock_providers.py. Run AFTER checks_v2.py/e2e_v2.py on a fresh run_env_v2.sh instance (this script restarts
the app process itself via the real update mechanism, so run it last / in its own instance).
Run: bash run_env_v2.sh && python3 update_check.py
"""
import json
import re
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
RUN = HERE / "run_v2"
PORT = int(re.search(r"127\.0\.0\.1:(\d+)", (RUN / "app.out").read_text()).group(1))
MOCK_PORT = 9200
TOKEN = "test-token-v2"
fails = []


def api(port, path, body=None, timeout=15):
    url = f"http://127.0.0.1:{port}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method="POST" if body is not None else "GET")
    req.add_header("X-Tapthu-Token", TOKEN)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def mock_control(sha, mode, date="2026-09-29T00:00:00Z"):
    req = urllib.request.Request(f"http://127.0.0.1:{MOCK_PORT}/github/_control",
                                  data=json.dumps({"sha": sha, "mode": mode, "date": date}).encode(),
                                  headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read().decode())


def alive(port, timeout=2):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False


def check(name, cond):
    print(("OK  " if cond else "FAIL") + " " + name)
    if not cond:
        fails.append(name)


# 0) baseline: app should have already adopted the mock's initial sha within its first 5s poll
time.sleep(6)
s = api(PORT, "/api/state")
check("baseline version adopted on first poll", s["update"]["version"]["sha"].startswith("0000000"))
check("update mechanism reports no error yet", not s["update"]["state"].get("rollback"))

# 1) successful update: new process takes over the same "next port", old process exits
mock_control("1111111goodcommit1111111111111111111111", "good", "2026-09-29T01:00:00Z")
r = api(PORT, "/api/update/check_now", {})
check("check_now accepted", r.get("ok"))
time.sleep(3)
s = api(PORT, "/api/state")
applied = s["update"]["state"].get("applied")
check("update applied and new_port reported", bool(applied) and applied.get("new_port") == PORT + 1)
check("new process is healthy on PORT+1", alive(PORT + 1))
s2 = api(PORT + 1, "/api/state")
check("new process kept the same project data (same DATA_DIR)", s2["data_dir"] == s["data_dir"])
check("new process reports the new version", s2["update"]["version"]["sha"].startswith("1111111"))
time.sleep(5)
check("old process exited after handoff", not alive(PORT))

# 2) rollback: broken update never disturbs the (now new, on PORT+1) running process
mock_control("badbadbad2222222222222222222222222222", "broken", "2026-09-29T02:00:00Z")
r = api(PORT + 1, "/api/update/check_now", {})
check("check_now (rollback scenario) accepted", r.get("ok"))
time.sleep(10)
check("process serving throughout the failed update stayed up", alive(PORT + 1))
s3 = api(PORT + 1, "/api/state")
rb = s3["update"]["state"].get("rollback")
check("rollback recorded with a from/to sha", bool(rb) and rb.get("from", "").startswith("badbadbad"))
check("version did not move to the broken commit", not s3["update"]["version"]["sha"].startswith("badbadbad"))
check("no broken process left listening on PORT+2", not alive(PORT + 2))

print()
if fails:
    print(f"{len(fails)} check(s) failed:", fails)
    raise SystemExit(1)
print("All update checks passed.")
