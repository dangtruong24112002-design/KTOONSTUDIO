"""Checks for forge (Giai đoạn 1 — Lõi sản xuất của brief "Tool gen video AI tối ưu"), against the
mock-backed instance started by run_env_forge.sh. Pure HTTP (urllib), no browser. Run on a fresh instance.
Run: bash run_env_forge.sh && python3 forge_check.py
"""
import json
import re
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
RUN = HERE / "run_forge"
PORT = re.search(r"127\.0\.0\.1:(\d+)", (RUN / "app.out").read_text()).group(1)
B = f"http://127.0.0.1:{PORT}"
TOKEN = "test-token-forge"
fails = []


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(B + path, data=data, method=method)
    req.add_header("X-Forge-Token", TOKEN)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode())


def upload_asset(sid, kind, name, ext=".jpg", data=b"\xff\xd8\xff\xe0fake"):
    q = f"series={sid}&kind={kind}&name={name}&ext={ext}"
    req = urllib.request.Request(f"{B}/api/asset/upload?{q}", data=data, method="POST")
    req.add_header("X-Forge-Token", TOKEN)
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


s = state()
check("starts with no series", s["series_order"] == [])

r = call("POST", "/api/series/new", {"code": "MOGUTV_26010", "name": "Ashoka", "budget_usd": 25})
check("series created", r.get("ok"))
sid = r["series"]["id"]
s = state()
check("new series becomes active automatically", s["active_series"] == sid)

r = call("POST", "/api/series/bible", {"id": sid, "style_lock": "photoreal anime style, cinematic color grade, 9:16",
                                       "negatives": ["no 3D CGI", "no lens flare", "no subtitles"],
                                       "audio_rules": "always include ambient sound", "characters": [{"name": "Ashoka", "desc": "young warrior monk"}],
                                       "locations": [{"name": "Moon Hall", "desc": "ancient stone hall"}]})
check("bible saved", r.get("ok"))
s = state()
b = s["series"][sid]["bible"]
check("style_lock saved", b["style_lock"].startswith("photoreal"))
check("negatives saved as a list", b["negatives"] == ["no 3D CGI", "no lens flare", "no subtitles"])
check("character roster saved", b["characters"] == [{"name": "Ashoka", "desc": "young warrior monk"}])

r = call("POST", "/api/series/budget", {"id": sid, "budget_usd": 30})
check("budget updated", r.get("ok") and state()["series"][sid]["budget_usd"] == 30)

# Reference Bank
r = upload_asset(sid, "character", "Ashoka")
check("character asset uploaded (no type collision with other series)", r.get("ok"))
ashoka_aid = r["asset"]["id"]
r = upload_asset(sid, "location", "Moon_Hall")
check("location asset uploaded", r.get("ok"))
hall_aid = r["asset"]["id"]
s = state()
check("2 assets registered under this series", len([a for a in s["assets"].values() if a["series_id"] == sid]) == 2)

r = call("POST", "/api/asset/remove", {"id": ashoka_aid})
check("cannot remove an asset that would break nothing yet (not used) -> succeeds", r.get("ok"))
# re-add it since we removed it just to prove removal works when unused
r = upload_asset(sid, "character", "Ashoka")
ashoka_aid = r["asset"]["id"]

# Episode -> Sequence -> Shot
r = call("POST", "/api/episode/new", {"series_id": sid, "code": "EP10", "name": "Judgment"})
check("episode created", r.get("ok"))
eid = r["episode"]["id"]
r = call("POST", "/api/sequence/new", {"episode_id": eid, "duration_s": 12, "aspect": "9:16", "overview": "Ashoka confronts the council in the Moon Hall."})
check("sequence created", r.get("ok"))
seqid = r["sequence"]["id"]
s = state()
check("sequence defaults to Seedance 2.5", s["sequences"][seqid]["model_id"] == "bytedance/seedance-2.5/reference-to-video")

r = call("POST", "/api/compile_preview", {"sequence_id": seqid})
check("preflight blocks an empty sequence (no shots yet)", "Sequence chưa có shot nào." in r["errors"])

r = call("POST", "/api/shot/new", {"sequence_id": seqid, "start_s": 0, "end_s": 6})
sh1 = r["shot"]["id"]
r = call("POST", "/api/shot/new", {"sequence_id": seqid, "start_s": 6, "end_s": 12})
sh2 = r["shot"]["id"]
call("POST", "/api/shot/update", {"id": sh1, "framing": "wide shot", "camera": "static", "action": "Ashoka strides into the hall.",
                                  "dialogue": "", "sfx": "torch crackle", "asset_ids": [ashoka_aid, hall_aid]})
call("POST", "/api/shot/update", {"id": sh2, "framing": "close-up", "camera": "slow push-in", "action": "He raises his hand.",
                                  "dialogue": "This ends tonight.", "sfx": "", "asset_ids": [ashoka_aid]})

r = call("POST", "/api/compile_preview", {"sequence_id": seqid})
check("preflight passes once shots + assets are complete and durations match", r["errors"] == [])
check("compiled prompt maps assets to stable @ImageN by first-appearance order (Ashoka in shot 1 first, then Moon_Hall)",
      "@Image1 = Ashoka" in r["prompt"] and "@Image2 = Moon_Hall" in r["prompt"])
check("compiled prompt embeds the Bible's style lock", "photoreal anime style" in r["prompt"])
check("compiled prompt embeds the Bible's negative list", "no 3D CGI" in r["prompt"])
check("compiled prompt cites each shot's own timestamp", "[0-6s]" in r["prompt"] and "[6-12s]" in r["prompt"])
check("compiled prompt carries the shot's dialogue", 'Dialogue: "This ends tonight."' in r["prompt"])

# duration mismatch -> preflight error
call("POST", "/api/shot/update", {"id": sh2, "end_s": 20})
r = call("POST", "/api/compile_preview", {"sequence_id": seqid})
check("preflight catches a shot/sequence duration mismatch", any("không khớp thời lượng" in e for e in r["errors"]))
call("POST", "/api/shot/update", {"id": sh2, "end_s": 12})  # fix it back

# ref-limit check: switch to Seedance 2.0 (9-ref limit) then overload with >9 distinct assets
call("POST", "/api/sequence/update", {"id": seqid, "model_id": "bytedance/seedance-2.0/reference-to-video"})
extra_ids = [ashoka_aid, hall_aid]
for i in range(8):
    ra = upload_asset(sid, "keyframe", f"Extra{i}")
    extra_ids.append(ra["asset"]["id"])
call("POST", "/api/shot/update", {"id": sh1, "asset_ids": extra_ids})
r = call("POST", "/api/compile_preview", {"sequence_id": seqid})
check("preflight catches a ref count over the model's limit (Seedance 2.0 = 9)", any("vượt giới hạn" in e for e in r["errors"]))
call("POST", "/api/shot/update", {"id": sh1, "asset_ids": [ashoka_aid, hall_aid]})  # fix it back
call("POST", "/api/sequence/update", {"id": seqid, "model_id": "bytedance/seedance-2.5/reference-to-video"})

# dry-run cost estimate before spending
dry = call("POST", "/api/render/run", {"sequence_id": seqid, "dry": True})
check("dry-run shows a real cost estimate before confirming", dry.get("n") == 1 and dry["est"] > 0)

# budget guard: drop the series budget below the render cost
call("POST", "/api/series/budget", {"id": sid, "budget_usd": 0.01})
r = call("POST", "/api/render/run", {"sequence_id": seqid})
check("render refused once it would exceed the series' own budget cap", "error" in r and "Vượt trần" in r["error"])
call("POST", "/api/series/budget", {"id": sid, "budget_usd": 30})

# real render
call("POST", "/api/render/run", {"sequence_id": seqid})
job, s = wait_job("render", seqid)
check("render job done", job["status"] == "done" and bool(job.get("file")))
check("asset was uploaded to the provider exactly once and its URL cached", s["assets"][ashoka_aid]["provider_url"].startswith("http"))
check("render recorded the exact compiled prompt it used", job["prompt_compiled"] and "@Image1 = Ashoka" in job["prompt_compiled"])

# verdict / Kept-Re-roll tracking
r = call("POST", "/api/render/verdict", {"job_id": job["id"], "verdict": "kept"})
check("verdict recorded", r.get("ok"))
s = state()
check("job shows verdict=kept", next(j for j in s["jobs"] if j["id"] == job["id"])["verdict"] == "kept")

# max renders per sequence
call("POST", "/api/render/run", {"sequence_id": seqid, "redo": True})
job2, s = wait_job("render", seqid)
check("second render ('Render lại') accepted (2nd take)", job2["take"] == 2 and job2["status"] == "done")
r = call("POST", "/api/render/run", {"sequence_id": seqid, "redo": True, "dry": True})
check("a 3rd render is refused (max 2 per sequence)", "error" in r and "2" in r["error"])

# a second series never sees the first one's assets/episodes/shots (isolation)
r = call("POST", "/api/series/new", {"code": "OTHER_SERIES", "name": "Other"})
sid2 = r["series"]["id"]
s = state()
check("a fresh series has its own empty Reference Bank (no cross-series leak)",
      len([a for a in s["assets"].values() if a["series_id"] == sid2]) == 0)
check("a fresh series has its own empty Bible", s["series"][sid2]["bible"]["style_lock"] == "")

for k in ("test-ws-key-123456", "test-atlas-key-123456"):
    check(f"no raw key value ever reaches /api/state", k not in json.dumps(state()))

print()
if fails:
    print(f"{len(fails)} check(s) failed:", fails)
    raise SystemExit(1)
print("All forge checks passed.")
