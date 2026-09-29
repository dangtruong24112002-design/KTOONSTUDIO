"""Extra hard-rule checks for tap_thu_v2 (spec SPEC_TAP_THU_V2.md, addendum #3 / mục 15), against the
mock-backed instance started by run_env_v2.sh. Pure HTTP (urllib), no browser, no LLM calls needed —
sets up its own minimal fixtures. Run BEFORE e2e_v2.py on a fresh instance. Never calls real APIs.
"""
import json
import re
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
RUN = HERE / "run_v2"
PORT = re.search(r"127\.0\.0\.1:(\d+)", (RUN / "app.out").read_text()).group(1)
B = f"http://127.0.0.1:{PORT}"
TOKEN = "test-token-v2"
KEY_STRINGS = ["test-ws-key-123456", "test-atlas-key-123456"]
fails = []


def call(method, path, body=None, raw=None, ctype=None):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(B + path, data=data, method=method)
    req.add_header("X-Tapthu-Token", TOKEN)
    req.add_header("Content-Type", ctype or ("application/octet-stream" if raw is not None else "application/json"))
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode())


def check(name, cond):
    print(("OK  " if cond else "FAIL") + " " + name)
    if not cond:
        fails.append(name)


call("POST", "/api/project", {"name": "ChecksProj"})
ch = call("POST", "/api/char/new", {"name": "Ethan"})["char"]

# 1) real + face is refused
r = call("POST", f"/api/upload?kind=component&char={ch['id']}&label=x&source=real&use=face&ext=.jpg",
         raw=b"\xff\xd8\xff\xe0fake")
check("real+face component refused", bool(r.get("error")) and "thật" in r["error"])
# sanity: the same upload with source=ai must succeed
r2 = call("POST", f"/api/upload?kind=component&char={ch['id']}&label=x&source=ai&use=face&ext=.jpg",
          raw=b"\xff\xd8\xff\xe0fake")
check("ai+face component accepted", "component" in r2)

# 1b) real + face is refused for a chat attachment too (addendum #2 §5)
ra = call("POST", "/api/upload?kind=chat_attach&label=shirt&source=real&use=face&ext=.jpg", raw=b"\xff\xd8\xff\xe0fake")
check("real+face chat attachment refused", bool(ra.get("error")) and "thật" in ra["error"])

# 1c) a bank item marked not-approved is refused for image generation until approved
pre = call("POST", "/api/char/new", {"name": "Placeholder"})
call("POST", "/api/approve", {"bank": "chars", "id": pre["char"]["id"], "approved": False})
p_blocked = call("POST", "/api/run", {"stage": "portrait", "target": pre["char"]["id"], "dry": True})
check("unapproved bank item blocked from image generation", bool(p_blocked.get("error")))

# 2) batch splitting + gen dependency chain (addendum #3 §15 B.8/B.10)
ep = call("POST", "/api/episode/new", {"name": "Checks"})["episode"]
eid = ep["id"]
shots = [
    {"id": "SH01", "duration": 10, "location": "Corridor", "cast": ["Ethan"], "desc": "a"},
    {"id": "SH02", "duration": 10, "location": "Boardroom", "cast": ["Ethan"], "desc": "b"},
]
call("POST", "/api/episode/shots", {"ep": eid, "shots": shots})
call("POST", "/api/episode/batches/split", {"ep": eid})
st = call("GET", "/api/state")
batches = st["episodes"][eid]["batches"]
check("two locations produce two batches", len(batches) == 2)
b1, b2 = batches[0]["id"], batches[1]["id"]
check("first batch is hook tier", st["episodes"][eid]["batches"][0]["tier"] == "hook")
check("last batch is cliffhanger tier", st["episodes"][eid]["batches"][1]["tier"] == "cliffhanger")

p1 = call("POST", "/api/run", {"stage": "gen", "target": b2, "dry": True})
check(f"{b2} gen blocked before its prompt is approved", bool(p1.get("error")))

# approve b2's prompt directly (bypassing the LLM) to isolate the last-frame dependency
call("POST", "/api/prompt", {"batch": b2, "text": "placeholder prompt", "approved": True})
p2 = call("POST", "/api/run", {"stage": "gen", "target": b2, "dry": True})
check(f"{b2} gen blocked without {b1}'s last frame (once its own prompt is approved)",
      bool(p2.get("error")) and b1 in p2["error"])

# an episode-wide bulk gen call must silently skip a batch waiting on the previous one's
# last frame instead of erroring the whole batch out (addendum #3 §15 B.10: "batch nối tiếp chờ...")
call("POST", "/api/prompt", {"batch": b1, "text": "placeholder prompt", "approved": True})
p3 = call("POST", "/api/run", {"stage": "gen", "target": eid, "dry": True})
check(f"episode-wide gen dry-run only offers {b1} (waits on it before {b2})",
      not p3.get("error") and p3["n"] == 1 and b1 in p3["items"][0])

# 2b) max_edits_per_image caps chat-edit attempts (addendum #2 §7)
call("POST", f"/api/upload?kind=component&char={ch['id']}&label=face&source=ai&use=face&ext=.jpg", raw=b"\xff\xd8\xff\xe0fake")
call("POST", "/api/run", {"stage": "portrait", "target": ch["id"]})
for _ in range(30):
    if call("GET", "/api/state")["picks"].get("portrait:" + ch["id"]):
        break
    time.sleep(0.3)
call("POST", "/api/settings", {"settings": {"max_edits_per_image": 1}})
c1 = call("POST", "/api/chat", {"kind": "portrait", "target": ch["id"], "text": "edit 1",
                                "model": "bytedance/seedream-v5.0-flash/edit", "resolution": "2k"})
check("first chat-edit within cap succeeds", "job" in c1)
c2 = call("POST", "/api/chat", {"kind": "portrait", "target": ch["id"], "text": "edit 2",
                                "model": "bytedance/seedream-v5.0-flash/edit", "resolution": "2k"})
check("chat-edit blocked once max_edits_per_image is reached", bool(c2.get("error")))

# 3) reference library: a THAT\ (real) image can never be suggested/tagged for face/eyes (addendum #3 §15 A.4)
reflib_dir = RUN / "reflib_fixture"
(reflib_dir / "AI").mkdir(parents=True, exist_ok=True)
(reflib_dir / "THAT").mkdir(parents=True, exist_ok=True)
img_bytes = (HERE / "files" / "img.jpg").read_bytes()
(reflib_dir / "AI" / "face1.jpg").write_bytes(img_bytes)
(reflib_dir / "THAT" / "costume1.jpg").write_bytes(img_bytes)
rl = call("POST", "/api/reflib/path", {"path": str(reflib_dir)})
check("reflib path accepted", rl.get("ok"))
call("POST", "/api/run", {"stage": "reflib_scan"})
for _ in range(30):
    st = call("GET", "/api/state")
    if st["reflib"]["n_unscanned"] == 0 and st["reflib"]["n_scanned"] >= 2:
        break
    time.sleep(0.3)
check("reflib scan tagged both images", st["reflib"]["n_scanned"] >= 2 and st["reflib"]["n_unscanned"] == 0)
# add_component with a real-sourced reflib path must still refuse face/eyes even if mis-tagged upstream
that_path = str(reflib_dir / "THAT" / "costume1.jpg")
rc = call("POST", f"/api/upload?kind=component&char={ch['id']}&label=x&source=real&use=eyes&ext=.jpg", raw=img_bytes)
check("real THAT-sourced image still refused for eyes even via ordinary upload path", bool(rc.get("error")))

# 4) no key value ever appears in state.json, the ledger, the log, or the /api/state payload
s = call("GET", "/api/state")
blobs = {
    "state.json": (RUN / "output" / "state.json").read_text() if (RUN / "output" / "state.json").exists() else "",
    "nhat_ky.txt": (RUN / "output" / "nhat_ky.txt").read_text() if (RUN / "output" / "nhat_ky.txt").exists() else "",
    "so_chi.csv": (RUN / "output" / "so_chi.csv").read_text() if (RUN / "output" / "so_chi.csv").exists() else "",
    "/api/state": json.dumps(s),
}
for name, blob in blobs.items():
    check(f"no raw key value in {name}", not any(k in blob for k in KEY_STRINGS))

print()
if fails:
    print(f"{len(fails)} check(s) failed:", fails)
    raise SystemExit(1)
print("All extra checks passed.")
