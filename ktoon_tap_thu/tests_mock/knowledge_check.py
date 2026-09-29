"""Checks for the knowledge library (docs/SPEC_TAP_THU_V2.md §19, yêu cầu #7), against the mock-backed
instance started by run_env_v2.sh. Pure HTTP (urllib), no browser. Run on a fresh instance.
Run: bash run_env_v2.sh && python3 knowledge_check.py
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
fails = []


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(B + path, data=data, method=method)
    req.add_header("X-Tapthu-Token", TOKEN)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode())


def check(name, cond):
    print(("OK  " if cond else "FAIL") + " " + name)
    if not cond:
        fails.append(name)


def state():
    return call("GET", "/api/state")


def wait_job(kind, target, timeout=20):
    t0 = time.time()
    while time.time() - t0 < timeout:
        s = state()
        js = [j for j in s["jobs"] if j["kind"] == kind and j["target"] == target]
        if js and js[-1]["status"] not in ("queued", "starting", "running"):
            return js[-1], s
        time.sleep(0.4)
    raise SystemExit(f"timeout waiting for {kind}:{target}")


call("POST", "/api/project", {"name": "KbProj"})

# 1) paste a new doc, check version 1
r = call("POST", "/api/knowledge/paste", {"type": "shotlist_kich_ban", "name": "Mẫu shot list", "text": "EP01 shot 1: wide shot. Keep it terse."})
check("new doc created", r.get("ok"))
kid = r["id"]
s = state()
doc = s["knowledge"][kid]
check("doc has type shotlist_kich_ban", doc["type"] == "shotlist_kich_ban")
check("doc starts at v1", doc["current_v"] == 1 and len(doc["versions"]) == 1)

# 2) add a new version, then roll back
r = call("POST", "/api/knowledge/paste", {"id": kid, "text": "EP01 shot 1: wide shot, then a close-up. Two beats minimum."})
check("new version accepted", r.get("ok") and r["v"] == 2)
s = state()
check("current_v moved to 2, old version kept", s["knowledge"][kid]["current_v"] == 2 and len(s["knowledge"][kid]["versions"]) == 2)
r = call("POST", "/api/knowledge/set_version", {"id": kid, "v": 1})
check("rollback to v1 accepted", r.get("ok"))
s = state()
check("current_v rolled back to 1 (both versions still on record)", s["knowledge"][kid]["current_v"] == 1 and len(s["knowledge"][kid]["versions"]) == 2)
call("POST", "/api/knowledge/set_version", {"id": kid, "v": 2})  # leave it on the latest for the rest of the test

# 3) knowledge doc feeds a real job when no template is set: anh_nhan_vat -> portrait
ch = call("POST", "/api/char/new", {"name": "Ethan"})["char"]
req = urllib.request.Request(f"{B}/api/upload?kind=component&char={ch['id']}&label=face&source=ai&use=face&ext=.jpg",
                              data=b"\xff\xd8\xff\xe0fake", method="POST")
req.add_header("X-Tapthu-Token", TOKEN)
with urllib.request.urlopen(req, timeout=20) as resp:
    json.loads(resp.read().decode())

r = call("POST", "/api/knowledge/paste", {"type": "anh_nhan_vat", "name": "Mẫu ảnh nhân vật", "text": "Always a plain white cyclorama backdrop, three-point studio lighting, 3:4 portrait crop."})
check("anh_nhan_vat doc created", r.get("ok"))
anh_kid = r["id"]

call("POST", "/api/run", {"stage": "portrait", "target": ch["id"]})
job, s = wait_job("portrait", ch["id"])
check("portrait job done", job["status"] == "done")
used = job.get("knowledge_used") or []
check("portrait job recorded the knowledge doc used (no template set)", any(u.get("id") == anh_kid for u in used))

# 4) template takes priority over the knowledge library once set
call("POST", "/api/template", {"key": "char_single", "text": "A owner-written template for single character portraits."})
call("POST", "/api/run", {"stage": "portrait", "target": ch["id"], "redo": True})
job2, s = wait_job("portrait", ch["id"])
used2 = job2.get("knowledge_used") or []
check("template now takes priority over the knowledge doc", any(u.get("template") == "char_single" for u in used2))
call("POST", "/api/template", {"key": "char_single", "text": ""})  # clear it back out for hygiene

# 5) a long document needs condensing; condensing shrinks the injected text (and therefore its cost impact)
long_text = "This is one repeated sentence about camera movement and lighting continuity. " * 400  # ~3200 words
r = call("POST", "/api/knowledge/paste", {"type": "video_prompt", "name": "Cấu trúc prompt dài", "text": long_text})
vp_kid = r["id"]
s = state()
ver = s["knowledge"][vp_kid]["versions"][0]
check("long doc flagged as needing condensing", ver["needs_condense"] and ver["word_count"] > s["condense_word_threshold"])

# an episode+batch to have something to price a "prompt" stage dry-run against
call("POST", "/api/script_raw", {"text": "EP01\nINT. ROOM. Ethan stands there.\nShot 1: wide shot, 6s."})
call("POST", "/api/episode/new", {"name": "Kb"})
s = state()
eid = s["episodes_order"][0]
call("POST", "/api/episode/shots", {"ep": eid, "shots": [{"id": "SH01", "duration": 6, "location": "Room", "cast": ["Ethan"], "desc": "wide shot"}]})
call("POST", "/api/episode/batches/split", {"ep": eid})
s = state()
bid = s["episodes"][eid]["batches"][0]["id"]

dry_before = call("POST", "/api/run", {"stage": "prompt", "target": bid, "dry": True})
check("prompt dry-run priced with the long raw doc", dry_before["n"] == 1)

call("POST", "/api/run", {"stage": "condense_knowledge", "target": vp_kid})
cjob, s = wait_job("condense_knowledge", vp_kid)
check("condense job done", cjob["status"] == "done")
ver = s["knowledge"][vp_kid]["versions"][0]
check("condensed_text populated", bool(ver["condensed_text"].strip()))
check("not approved yet -> still using the raw (long) text", not ver["condensed_approved"])

dry_still_long = call("POST", "/api/run", {"stage": "prompt", "target": bid, "dry": True})
check("price unchanged before approval (still raw text)", abs(dry_still_long["est"] - dry_before["est"]) < 1e-6)

call("POST", "/api/knowledge/condensed", {"id": vp_kid, "approved": True})
s = state()
check("approved flag set", s["knowledge"][vp_kid]["versions"][0]["condensed_approved"])
dry_after = call("POST", "/api/run", {"stage": "prompt", "target": bid, "dry": True})
check("price drops once the short condensed text is used instead of the long raw one",
      dry_after["est"] < dry_before["est"])

# 6) remove a doc
call("POST", "/api/knowledge/remove", {"id": vp_kid})
s = state()
check("doc removed", vp_kid not in s["knowledge"])

print()
if fails:
    print(f"{len(fails)} check(s) failed:", fails)
    raise SystemExit(1)
print("All knowledge library checks passed.")
