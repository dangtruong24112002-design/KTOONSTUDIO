"""Checks for tap1 (yêu cầu #8 — bản tối giản: 1 trang, 3 bước, "The Alpha" EP01), against the
mock-backed instance started by run_env_tap1.sh. Pure HTTP (urllib), no browser. Run on a fresh instance.
Run: bash run_env_tap1.sh && python3 tap1_check.py
"""
import json
import re
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
RUN = HERE / "run_tap1"
PORT = re.search(r"127\.0\.0\.1:(\d+)", (RUN / "app.out").read_text()).group(1)
B = f"http://127.0.0.1:{PORT}"
TOKEN = "test-token-tap1"
fails = []


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(B + path, data=data, method=method)
    req.add_header("X-Tap1-Token", TOKEN)
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


PROFILES = ("Alpha: alpha sói đầu đàn, cao lớn, tóc đen, mắt hổ phách, nghiêm nghị.\n"
            "Bride: cô dâu con người, tóc nâu dài, ánh mắt kiên định, không sợ hãi.")
CHAR_TPL = "Photoreal single-character portrait, solid white background, one person only, 9:16."
SHOTLIST = ("SHOT 1: Alpha strides into the great hall, eyes locked on the door.\n"
            "SHOT 2: The Bride enters, Alpha turns to face her.\n"
            "SHOT 3: They stare each other down.")
VIDEO_TPL = "[Creatives Description] ... [Plot per timestamp] ... [Global supplement] ... Prohibited: ..."

s = state()
check("project is fixed to The Alpha", s["project"] == "The Alpha")
check("episode is fixed to EP01", s["episode"] == "EP01")
check("default LLM is claude-opus-5.5", s["settings"]["llm_model"] == "anthropic/claude-opus-5.5")
check("LLM catalog offers exactly the 3 named models",
      {m["id"] for m in s["llm_catalog"]} == {"anthropic/claude-opus-5.5", "openai/gpt-6-astra", "openai/gpt-6-sol"})
check("video model catalog offers 2.5 (default) and 2.0",
      {m["id"] for m in s["video_models"]} == {"bytedance/seedance-2.5/reference-to-video", "bytedance/seedance-2.0/reference-to-video"})

r = call("POST", "/api/settings", {"llm_model": "openai/gpt-6-sol"})
check("LLM model switchable", r.get("ok") and state()["settings"]["llm_model"] == "openai/gpt-6-sol")
call("POST", "/api/settings", {"llm_model": "anthropic/claude-opus-5.5"})  # back to default for the rest

# ---------------------------------------------------------------- Bước 1: nhân vật
call("POST", "/api/profiles", {"text": PROFILES})
call("POST", "/api/char_tpl", {"text": CHAR_TPL})
call("POST", "/api/run", {"stage": "char_prompt", "target": "all"})
job, s = wait_job("char_prompt", "all")
check("char_prompt job done", job["status"] == "done")
check("2 characters parsed out", len(s["char_order"]) == 2)
names = sorted(s["chars"][cid]["name"] for cid in s["char_order"])
check("character names are Alpha + Bride", names == ["Alpha", "Bride"])
alpha_id = next(cid for cid in s["char_order"] if s["chars"][cid]["name"] == "Alpha")
bride_id = next(cid for cid in s["char_order"] if s["chars"][cid]["name"] == "Bride")
check("each character got its own English image prompt", all(s["chars"][cid]["prompt"].strip() for cid in s["char_order"]))

r = call("POST", "/api/char/approve", {"id": alpha_id, "approved": True})
check("cannot approve a character with no image yet", "error" in r)

call("POST", "/api/run", {"stage": "char_gen", "target": alpha_id})
aj, s = wait_job("char_gen", alpha_id)
check("Alpha's image job done", aj["status"] == "done" and bool(aj.get("file")))
call("POST", "/api/run", {"stage": "char_gen", "target": bride_id})
bj, s = wait_job("char_gen", bride_id)
check("Bride's image job done", bj["status"] == "done" and bool(bj.get("file")))

r = call("POST", "/api/char/approve", {"id": alpha_id, "approved": True})
check("Alpha now approvable", r.get("ok"))
r = call("POST", "/api/char/approve", {"id": bride_id, "approved": True})
check("Bride now approvable", r.get("ok"))
s = state()
check("both characters flagged approved", s["chars"][alpha_id]["approved"] and s["chars"][bride_id]["approved"])

# "Làm lại": a redo creates a NEW take, uncapped (only video has a 2-take cap)
call("POST", "/api/run", {"stage": "char_gen", "target": alpha_id, "redo": True})
wait_job("char_gen", alpha_id)
s = state()
alpha_takes = [j for j in s["jobs"] if j["kind"] == "char_gen" and j["target"] == alpha_id]
check("'Làm lại' created a second take for Alpha (no cap on character images)", len(alpha_takes) == 2)

# owner upload replaces the pick outright
req = urllib.request.Request(f"{B}/api/char/upload_image?char={bride_id}&ext=.jpg", data=b"\xff\xd8\xff\xe0fake", method="POST")
req.add_header("X-Tap1-Token", TOKEN)
with urllib.request.urlopen(req, timeout=20) as resp:
    up = json.loads(resp.read().decode())
check("owner-uploaded image accepted", up.get("ok"))
s = state()
up_job = next(j for j in s["jobs"] if j["id"] == up["job"])
check("owner upload registered as a free, instant, done take", up_job["provider"] == "local" and up_job["cost"] == 0 and up_job["status"] == "done")

# ---------------------------------------------------------------- Bước 2: prompt video
call("POST", "/api/shotlist", {"text": SHOTLIST})
call("POST", "/api/video_tpl", {"text": VIDEO_TPL})
call("POST", "/api/run", {"stage": "group", "target": "ep"})
gjob, s = wait_job("group", "ep")
check("group job done", gjob["status"] == "done")
check("2 batches produced", len(s["batches"]) == 2)
b1, b2 = s["batches"]
check("batch 1 kept its verbatim shot text", "Alpha strides into the great hall" in b1["shots_text"])
check("batch 1 flagged with a dialogue-duration warning (4s vs ~11 words)", bool(b1["dialogue_note"]) and not b1["dialogue_ok"])
check("batch 2's dialogue fits its duration, no warning", b2["dialogue_ok"] and not b2["dialogue_note"])
check("batch 2 lists both characters", set(b2["characters"]) == {"Alpha", "Bride"})
check("default video model is Seedance 2.5 on both batches",
      b1["model"] == "bytedance/seedance-2.5/reference-to-video" and b2["model"] == "bytedance/seedance-2.5/reference-to-video")
check("neither batch has a prompt yet (writing it is a separate step)", not b1["prompt"] and not b2["prompt"])

call("POST", "/api/run", {"stage": "batch_prompt", "target": b1["id"]})
p1job, s = wait_job("batch_prompt", b1["id"])
check("batch 1 prompt job done", p1job["status"] == "done")
b1 = next(x for x in s["batches"] if x["id"] == b1["id"])
check("batch 1 got its prompt text", bool(b1["prompt"].strip()))
check("app computed @Image1 = Alpha for batch 1 itself (echoed back by the mock, not just a static string)",
      "@Image1 = Alpha" in b1["prompt"])

call("POST", "/api/run", {"stage": "batch_prompt", "target": b2["id"]})
p2job, s = wait_job("batch_prompt", b2["id"])
check("batch 2 prompt job done", p2job["status"] == "done")
b2p = next(x for x in s["batches"] if x["id"] == b2["id"])["prompt"]
check("app computed BOTH @Image1 = Alpha and @Image2 = Bride for batch 2 (2 approved characters present)",
      "@Image1 = Alpha" in b2p and "@Image2 = Bride" in b2p)

# hand edit + save
call("POST", "/api/batch/prompt", {"id": b1["id"], "text": b1["prompt"] + " EDITED BY OWNER"})
s = state()
check("owner's hand edit to a batch prompt is kept", "EDITED BY OWNER" in next(x for x in s["batches"] if x["id"] == b1["id"])["prompt"])

call("POST", "/api/batch/model", {"id": b1["id"], "model": "bytedance/seedance-2.0/reference-to-video"})
s = state()
check("per-batch video model switchable to 2.0", next(x for x in s["batches"] if x["id"] == b1["id"])["model"] == "bytedance/seedance-2.0/reference-to-video")
call("POST", "/api/batch/model", {"id": b1["id"], "model": "bytedance/seedance-2.5/reference-to-video"})  # back to default

# ---------------------------------------------------------------- Bước 3: video
dry = call("POST", "/api/run", {"stage": "video_gen", "dry": True})
check("'Gen tất cả' dry-run shows both batches with a total estimate before confirming", dry["n"] == 2 and dry["est"] > 0)

call("POST", "/api/run", {"stage": "video_gen", "target": b1["id"]})
v1job, s = wait_job("video_gen", b1["id"])
check("batch 1 video job done", v1job["status"] == "done" and bool(v1job.get("file")))
check("video filename follows The_Alpha_EP01_<batch>_v<n>.mp4", v1job["file"] == f"The_Alpha_EP01_{b1['id']}_v1.mp4")

call("POST", "/api/run", {"stage": "video_gen", "target": b2["id"]})
wait_job("video_gen", b2["id"])

# max 2 gens per batch
call("POST", "/api/run", {"stage": "video_gen", "target": b1["id"], "redo": True})
v1b, s = wait_job("video_gen", b1["id"])
check("second gen ('Gen lại') for batch 1 accepted (2nd take)", v1b["take"] == 2 and v1b["status"] == "done")
r = call("POST", "/api/run", {"stage": "video_gen", "target": b1["id"], "redo": True, "dry": True})
check("a 3rd gen for the same batch is refused (max 2 per batch)", "error" in r and "2" in r["error"])

s = state()
check("money() reflects real spend across LLM + image + video jobs", s["money"]["spent"] > 0)
check("balances for both providers are tracked", "wavespeed" in s["balance"] and "atlas" in s["balance"])
for p, k in (("wavespeed", "WAVESPEED_API_KEY"), ("atlas", "ATLASCLOUD_API_KEY")):
    check(f"no raw {k} value ever reaches /api/state", "test-ws-key-123456" not in json.dumps(s) and "test-atlas-key-123456" not in json.dumps(s))

print()
if fails:
    print(f"{len(fails)} check(s) failed:", fails)
    raise SystemExit(1)
print("All tap1 checks passed.")
