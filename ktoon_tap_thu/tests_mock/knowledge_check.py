"""Checks for the slot-based knowledge library + "Thủ thư" librarian (docs/SPEC_TAP_THU_V2.md §20, yêu cầu
#7 bản chốt — supersedes the type-tagged library of §19), against the mock-backed instance started by
run_env_v2.sh. Pure HTTP (urllib), no browser. Run on a fresh instance.
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


# ---------------------------------------------------------------- fixture documents (mirror the shape the
# owner described: a global shot-list-workflow doc with no internal headers, and a project doc with §2/§3/
# §4/Master 01-06/§11 sub-parts/§12 headers).
FIXTURE_SHOTLIST_RULES = (
    "MASTER INSTRUCTION - CINEMATIC LITERARY SHOTLIST WORKFLOW\n\n"
    "Turn a screenplay excerpt into a numbered shot list for a vertical 9:16 microdrama. Group shots into "
    "sequences, tag every shot with Duration/Framing/Camera/Thoai/Character/SFX/Mood, preserve the exact "
    "number of beats implied by the source, and end every shot list with SOURCE and CONTINUITY NOTE lines."
)

FIXTURE_PROJECT = """## §2 Source decisions
Use the owner's approved character/environment/prop list as ground truth; never invent a location not in that list.

## §3 Project instruction
Project: The Alpha's Human Bride. Photoreal vertical 9:16 short-drama, English dialogue, US audience. Always
respect ALPHA PROJECT SYSTEM RULES: keep continuity, keep the werewolf-alpha romance tone, never break the 9:16 frame.

## §4 Reusable task input
DELIVERABLE: {{DELIVERABLE}}
EPISODE_AND_SHOTS: {{EPISODE_AND_SHOTS}}
APPROVED_SOURCE_EXCERPT:
{{APPROVED_SOURCE_EXCERPT}}

REFERENCE_MAP:
{{REFERENCE_MAP}}

STATE / START_STATE: {{START_STATE}}
OUTPUT_SETTINGS: {{OUTPUT_SETTINGS}}
OUTPUT_MODE: {{OUTPUT_MODE}}
TOOL_LIMITS: {{TOOL_LIMITS}}

## Master 01 - Character single portrait
Solid white background, 3:4, photoreal portrait, identity locked from references.

## Master 02 - Character sheet
Warm-grey studio background, 21:9, 4 body views + 4 face views.

## Master 03 - Location
Photoreal establishing wide shot, e.g. Moon Hall / Moonveil great hall, torch-lit stone walls.

## Master 04 - Prop
Photoreal studio product still, solid white background.

## Master 05 - Video prompt writer
ALPHA VIDEO PROMPT RULES: Write ONE Seedance prompt in English, citing only the given @Image/@Audio/@Video
numbers, structured as [Creatives Description] / [Plot per timestamp] / [Global supplement], ending with the
verbatim Prohibited line.

## Master 06 - Video prompt example
[Creatives Description] Example only. [Plot per timestamp] [0-3s] example beat. [Global supplement] example.
Prohibited: no subtitles, no BGM.

## §11a Continue Clip
When a batch continues a previous one, open on the exact END STATE described by the previous batch and never
restate the establishing shot.

## §11b Repair Image
Image-edit instructions must always state identity/face, aspect ratio and background stay unchanged except for
the requested change.

## §11c Review Result
Review format: PASS/FAIL plus a one-line reason, checked against the QC checklist below.

## §12 QC checklist
- Face and identity consistent with references
- No extra dialogue
- Correct aspect ratio 9:16"""

FIXTURE_PROJECT_V2 = FIXTURE_PROJECT.replace(
    "Warm-grey studio background, 21:9, 4 body views + 4 face views.",
    "Warm-grey studio background, 21:9, 4 body views + 4 face views + a foot-detail inset.")


call("POST", "/api/project", {"name": "Alpha Bride"})

# 1) global doc with no header structure -> forces the LLM split + LLM classify fallback (spec §20 item 1)
r = call("POST", "/api/knowledge/paste", {"name": "Shotlist Instruction", "text": FIXTURE_SHOTLIST_RULES})
check("shotlist-rules doc created", r.get("ok"))
shot_kid = r["id"]
s = state()
doc = s["knowledge"][shot_kid]
ver = doc["versions"][0]
check("no type tag was required to upload it", "type" not in doc)
check("scope auto-inferred as global (shotlist_rules is shared)", doc["scope"] == "global")
check("librarian produced at least one section", len(ver["sections"]) >= 1)
check("that section was assigned the shotlist_rules slot", any("shotlist_rules" in sec["slots"] for sec in ver["sections"]))
check("librarian LLM calls were logged as real jobs (budget rule)", any(j["kind"] == "kb_librarian" and j["target"] == shot_kid for j in s["jobs"]))

# 2) project doc WITH header structure -> pure heuristic + keyword classification, zero LLM cost
r = call("POST", "/api/knowledge/paste", {"name": "Alpha_Master_Prompts_EN", "text": FIXTURE_PROJECT})
check("project doc created", r.get("ok"))
proj_kid = r["id"]
s = state()
doc = s["knowledge"][proj_kid]
ver = doc["versions"][0]
check("scope auto-inferred as project (not shotlist_rules-only)", doc["scope"] == "project")
slot_map = {}
for sec in ver["sections"]:
    for sl in sec["slots"]:
        slot_map.setdefault(sl, []).append(sec["id"])
for expect in ("project_system", "task_form", "img_char_single", "img_char_sheet", "img_location", "img_prop",
              "video_writer", "video_example", "continue_clip", "repair_image", "review_result", "qc_checklist"):
    check(f"heuristic slot table covers {expect}", expect in slot_map)
check("§2+§3 both landed in project_system (multi-section slot)", len(slot_map.get("project_system", [])) == 2)
check("heuristic-only doc cost no LLM money (no kb_librarian job for it)",
      not any(j["kind"] == "kb_librarian" and j["target"] == proj_kid for j in s["jobs"]))
check("no slot conflicts yet", s["knowledge_conflicts"] == [])

# 3) re-upload the SAME name with one section tweaked -> new version, diffed, rollback-able
r = call("POST", "/api/knowledge/paste", {"name": "Alpha_Master_Prompts_EN", "text": FIXTURE_PROJECT_V2})
check("re-upload by name created v2 of the same doc (not a duplicate)", r.get("ok") and r["id"] == proj_kid and r["v"] == 2)
s = state()
ver2 = s["knowledge"][proj_kid]["versions"][1]
changed_titles = [sec["title"] for sec in ver2["sections"] if sec["changed"]]
check("diff flags only the Master 02 section as changed", changed_titles == ["## Master 02 - Character sheet"])
call("POST", "/api/knowledge/set_version", {"id": proj_kid, "v": 1})
check("rollback to v1 works", state()["knowledge"][proj_kid]["current_v"] == 1)
call("POST", "/api/knowledge/set_version", {"id": proj_kid, "v": 2})  # leave on latest for the rest of the test

# 4) character + portrait (img_char_single slot + project_system, always-on provenance) + sheet (owner's
# solid-white override beats Master 02's warm-grey)
ch = call("POST", "/api/char/new", {"name": "Alpha"})["char"]
req = urllib.request.Request(f"{B}/api/upload?kind=component&char={ch['id']}&label=face&source=ai&use=face&ext=.jpg",
                              data=b"\xff\xd8\xff\xe0fake", method="POST")
req.add_header("X-Tapthu-Token", TOKEN)
with urllib.request.urlopen(req, timeout=20) as resp:
    json.loads(resp.read().decode())
call("POST", "/api/run", {"stage": "portrait", "target": ch["id"]})
pjob, s = wait_job("portrait", ch["id"])
check("portrait job done", pjob["status"] == "done")
used = pjob.get("knowledge_used") or []
check("portrait used img_char_single slot", any(u.get("slot") == "img_char_single" for u in used))
check("portrait ALSO used project_system (every prompt-writing step, spec item 1)", any(u.get("slot") == "project_system" for u in used))

call("POST", "/api/run", {"stage": "sheet", "target": ch["id"]})
sjob, s = wait_job("sheet", ch["id"])
check("sheet job done", sjob["status"] == "done")
check("owner's solid-white override beat Master 02's warm-grey wording", "white" in (sjob.get("prompt") or "").lower())
used = sjob.get("knowledge_used") or []
check("sheet used img_char_sheet slot", any(u.get("slot") == "img_char_sheet" for u in used))

# 5) episode: script -> shot list via shotlist_rules (skippable if already written, spec §20 item 2a) ->
# sequence-based batch split (item 2b) -> dialogue-duration warning (item 5) -> video-prompt task_form
# auto-fill + dual REFERENCE_MAP + toggle (items 2c/4) -> continuation guard.
ep = call("POST", "/api/episode/new", {"name": "EP01"})["episode"]
eid = ep["id"]
call("POST", "/api/episode/script", {"ep": eid, "text": "INT. MOON HALL - NIGHT\nAlpha corners her.\n"})
call("POST", "/api/run", {"stage": "shotlist_from_script", "target": eid})
job, s = wait_job("shotlist_from_script", eid)
check("shotlist_from_script job done", job["status"] == "done")
check("job used the shotlist_rules slot", any(u.get("slot") == "shotlist_rules" for u in (job.get("knowledge_used") or [])))
ep = s["episodes"][eid]
check("shot list markdown stored verbatim", ep["shotlist_md"].strip() == job["result"].strip())
check("parsed 4 shots from the markdown", len(ep["shots"]) == 4)
check("sequence never crossed: 2 batches (one per # SEQUENCE)", len(ep["batches"]) == 2)
b1, b2 = ep["batches"][0], ep["batches"][1]
check("batch 1 = SEQUENCE 1's two shots", len(b1["shot_ids"]) == 2)
check("batch 2 = SEQUENCE 2's two shots", len(b2["shot_ids"]) == 2)
sh4 = next(x for x in ep["shots"] if x["id"].endswith("SH04"))
check("a shot with no Duration got one estimated from its dialogue (spec item 2b)", 2.5 <= sh4["duration"] <= 4.5)

dry = call("POST", "/api/run", {"stage": "prompt", "target": b1["id"], "dry": True})
check("dry-run flags the tight-dialogue shot with a warning (spec item 5, never auto-cut)", "⚠" in dry["items"][0])

call("POST", "/api/batch/ref_mode", {"id": b1["id"], "mode": "single"})
s = state()
check("ref_mode=single: mapping has the face-lock portrait, not the sheet",
      "face lock" in s["mapping"][b1["id"]] and "turnaround sheet" not in s["mapping"][b1["id"]])
call("POST", "/api/batch/ref_mode", {"id": b1["id"], "mode": "both"})
s = state()
check("ref_mode=both (default): mapping has BOTH the face-lock portrait and the turnaround sheet",
      "face lock" in s["mapping"][b1["id"]] and "turnaround sheet" in s["mapping"][b1["id"]])
check("sheet reference is explicitly labeled as never a starting frame", "NEVER a starting frame" in s["mapping"][b1["id"]])

call("POST", "/api/run", {"stage": "prompt", "target": b1["id"]})
job1, s = wait_job("prompt", b1["id"])
check("batch 1 prompt job done (no prior batch to wait on)", job1["status"] == "done")
check("prompt used project_system + video_writer + video_example + task_form",
      {"project_system", "video_writer", "video_example", "task_form"} <= {u.get("slot") for u in (job1.get("knowledge_used") or [])})
check("app auto-filled the task_form itself (job would have failed on a missing {{FIELD}})", job1["status"] == "done")

call("POST", "/api/run", {"stage": "prompt", "target": b2["id"]})
job2, s = wait_job("prompt", b2["id"])
check("batch 2 (continues batch 1) fails clearly instead of guessing — batch 1 has no video yet",
      job2["status"] == "failed" and b1["id"] in (job2.get("error") or ""))

# 6) a slot conflict between two different docs, flagged for the owner to choose (spec §20 item 1) — and
# condensing a long doc (>6000 words) only takes effect once explicitly approved (item 3).
long_text = "This is one repeated sentence about camera movement and lighting continuity for the video example rules. " * 400
r = call("POST", "/api/knowledge/paste", {"name": "Video Example Long Draft", "text": long_text})
long_kid = r["id"]
s = state()
long_ver = s["knowledge"][long_kid]["versions"][0]
check("long doc flagged as needing condensing (>6000 words)", long_ver["needs_condense"] and long_ver["word_count"] > s["condense_word_threshold"])
sec_id = long_ver["sections"][0]["id"]
call("POST", "/api/knowledge/set_section", {"id": long_kid, "sec_id": sec_id, "slots": ["video_example"], "approved": True})
s = state()
check("owner can re-file a section into any slot by hand", s["knowledge"][long_kid]["versions"][0]["sections"][0]["slots"] == ["video_example"])
check("two docs now claim video_example -> flagged as a conflict", "video_example" in s["knowledge_conflicts"])

dry_before = call("POST", "/api/run", {"stage": "prompt", "target": b1["id"], "dry": True, "redo": True})
call("POST", "/api/run", {"stage": "condense_knowledge", "target": long_kid})
cjob, s = wait_job("condense_knowledge", long_kid)
check("condense job done", cjob["status"] == "done")
ver = s["knowledge"][long_kid]["versions"][0]
check("condensed_text populated, not approved yet", bool(ver["condensed_text"].strip()) and not ver["condensed_approved"])
dry_still_long = call("POST", "/api/run", {"stage": "prompt", "target": b1["id"], "dry": True, "redo": True})
check("price unchanged before approval (still the raw long text)", abs(dry_still_long["est"] - dry_before["est"]) < 1e-6)
call("POST", "/api/knowledge/condensed", {"id": long_kid, "approved": True})
dry_after = call("POST", "/api/run", {"stage": "prompt", "target": b1["id"], "dry": True, "redo": True})
check("price drops once the short condensed text replaces the long raw one", dry_after["est"] < dry_before["est"])

# 7) storage on disk: shotlist_rules under the shared/global folder, the project doc under this project's
# own folder (spec §20 item 1: "Kiến thức lưu theo dự án", trừ Shotlist Instruction là kiến thức chung).
check("global doc mirrored under the shared kien_thuc_chung folder",
      any((RUN / "data" / "kien_thuc_chung" / shot_kid).glob("v*.txt")))
check("project doc mirrored under this project's own kien_thuc folder",
      any((RUN / "data" / "projects").glob(f"*/kien_thuc/{proj_kid}/v*.txt")))

# 8) remove a doc
call("POST", "/api/knowledge/remove", {"id": long_kid})
check("doc removed", long_kid not in state()["knowledge"])

print()
if fails:
    print(f"{len(fails)} check(s) failed:", fails)
    raise SystemExit(1)
print("All knowledge library (bản chốt) checks passed.")
