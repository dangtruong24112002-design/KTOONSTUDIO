"""Trạng thái + logic nghiệp vụ cho tap_thu_v2 (không có HTTP server ở đây, xem app.py).

Một "job" là một việc tốn tiền hoặc gọi LLM, chạy nền, có thể Resume sau khi tắt app.
Một file owner tải lên (component, sheet có sẵn, giọng, video ref...) cũng được ghi thành
một "job" giả, provider="local", cost=0, status="done" ngay — để dùng chung máy chọn phiên bản
(takes/pick) với ảnh video do máy tạo ra. Chỉ "component" của nhân vật là danh sách nhiều item
(không phải kiểu chọn 1 bản), vì một nhân vật cần nhiều ảnh thành phần cùng lúc.
"""
import csv
import json
import os
import re
import shutil
import subprocess
import threading
import time
import traceback
from datetime import datetime
from pathlib import Path

import providers
from providers import ApiError

HERE = Path(__file__).resolve().parent
OUT = HERE / "output"
PROJECTS = HERE / "projects"
STATE_FILE = OUT / "state.json"
LEDGER = OUT / "so_chi.csv"
LOG_FILE = OUT / "nhat_ky.txt"

# The KTOON_* overrides exist only for the offline test harness (tests_mock/run_env_v2.sh).
WS_BASE = os.environ.get("KTOON_WS_BASE", "https://api.wavespeed.ai/api/v3")
WS_LLM_BASE = os.environ.get("KTOON_WS_LLM", "https://llm.wavespeed.ai/v1")
ATLAS_BASE = os.environ.get("KTOON_ATLAS_BASE", "https://api.atlascloud.ai/api/v1/model")
ATLAS_PUB_BASE = os.environ.get("KTOON_ATLAS_PUB", "https://api.atlascloud.ai/public/v1")
POLL_SLEEP = float(os.environ.get("KTOON_POLL", "0.4"))
MEASURE_WAIT = float(os.environ.get("KTOON_MEASURE_WAIT", "0.3"))
PRICE_WARN_PER_S = 0.16
KEY_OF = {"wavespeed": "WAVESPEED_API_KEY", "atlas": "ATLASCLOUD_API_KEY"}
PROVIDER_NAME = {"wavespeed": "WaveSpeed", "atlas": "Atlas Cloud"}
VND_PER_USD = 26170
TARGET_VND = 30_000_000
CONTRACT_VND = 50_000_000
N_EPISODES = 60

GENS = ["S1", "S2a", "S2b", "S3"]
SEQ_OF = {"S1": "S1", "S2a": "S2", "S2b": "S2", "S3": "S3"}
DURATION = {"S1": 30, "S2a": 15, "S2b": 15, "S3": 30}
DEFAULT_TAG = {"S1": "hook", "S2": "normal", "S3": "cliffhanger"}
IMAGE_PRICE = {"1k": 0.14, "2k": 0.14, "4k": 0.24}
COMPONENT_USES = ["face", "eyes", "hair", "costume", "body", "pose", "other"]

DEFAULT_SETTINGS = {
    "llm_write": "openai/gpt-5.5", "llm_write_in": 5.0, "llm_write_out": 30.0,
    "llm_review": "google/gemini-3.6-flash", "llm_review_in": 0.75, "llm_review_out": 3.8,
    "image_resolution": "2k", "sheet_resolution": "2k",
    "storyboard_model": "bytedance/seedream-v5.0-flash/edit", "storyboard_price": 0.027,
    "video_S1": "bytedance/seedance-2.5/reference-to-video", "price_S1": 0.134,
    "video_S2a": "bytedance/seedance-2.0/reference-to-video", "price_S2a": 0.09,
    "video_S2b": "bytedance/seedance-2.0/reference-to-video", "price_S2b": 0.09,
    "video_S3": "bytedance/seedance-2.5/reference-to-video", "price_S3": 0.134,
    "resolution": "720p", "max_full_gens": 2, "max_edits_per_image": 10, "parallel": 2,
}
STAGE_NAME = {"style": "Phân tích style", "shots": "Shot list", "seq": "Sequences", "preprod": "Danh sách tiền kỳ",
              "portrait": "Ảnh nhân vật", "sheet": "Sheet 21:9", "env_wide": "Ảnh bối cảnh",
              "env_rev": "Bối cảnh (góc ngược)", "prop": "Ảnh prop", "voice": "Giọng", "video_ref": "Video ref",
              "storyboard": "Storyboard", "frame": "Cắt khung hình", "fix_img": "Ảnh sửa", "prompt": "Prompt",
              "review": "Duyệt prompt (Gemini)", "gen": "Sinh video", "patch": "Vá đoạn", "critique": "Nhận xét ảnh"}
ASYNC_KINDS = {"style", "shots", "seq", "preprod", "portrait", "sheet", "env_wide", "env_rev", "prop", "storyboard",
               "prompt", "review", "gen", "patch", "critique"}
LLM_KINDS = {"style", "shots", "seq", "preprod", "prompt", "review", "critique"}
IMAGE_KINDS = {"portrait", "sheet", "env_wide", "env_rev", "prop", "fix_img", "storyboard"}
EDITABLE_IMAGE_KINDS = {"portrait", "sheet", "env_wide", "env_rev", "prop", "storyboard"}
VIDEO_KINDS = {"gen", "patch"}
SERIES_KINDS = {"portrait", "sheet", "env_wide", "env_rev", "prop", "preprod"}

PROHIBITED = ("no subtitles, no BGM (unless explicitly requested), no exaggerated movements, no extra dialogue, "
              "no runny nose or premature tears, no AI-feel artifacts, no fast cuts when the shot is one continuous take")

STYLE_SYS = """You are a cinematographer analysing a vertical 9:16 microdrama screenplay for AI photoreal production.
Read the screenplay and write a short ENGLISH style block covering: visual tone, lens/camera language, lighting
palette, pacing, and the mood of the hook / twist / cliffhanger. 6-10 sentences, plain text, no markdown."""

SHOTS_SYS = """You produce a production shot list for a ~90-second vertical 9:16 microdrama, for AI image/video
generation. Return ONLY one JSON object: {"shots": [shot, ...]} where shot =
{"id": "SH01", "duration": int (4-15 seconds), "location": "short location name", "cast": ["character name", ...],
"props": ["prop name", ...], "desc": "English action/camera description of this shot",
"speaker": "character name or empty string", "line": "English dialogue or empty string"}.
If the user message already contains a shot list (pasted text or a table), you are a PARSER, not a writer:
keep exactly the same number of shots, the same order, and the same content, only reshaping it into this exact
JSON schema (split a duration you must guess to a sane 4-15s value if none was given). Never add, remove, merge
or drop a shot the user gave you.
If the user message contains NO shot list (only a screenplay/script), invent one yourself: 16-20 shots, total
duration 85-95 seconds, visual and filmable, natural short American-English dialogue."""

SEQ_SYS = """You group an EXISTING shot list (given to you as JSON, already has ids and durations) into
exactly 3 sequences of about 30 seconds each, for Seedance reference-to-video generation. You assign whole shots to
sequences — you never invent, edit, split or drop a shot. Return ONLY one JSON object:
{"S1": {"shot_ids": ["SH01", ...], "tag": "hook", "raccord_in": "", "raccord_out": "..."},
 "S2": {"shot_ids": [...], "tag": "normal"|"key", "raccord_in": "...", "raccord_out": "..."},
 "S3": {"shot_ids": [...], "tag": "cliffhanger", "raccord_in": "...", "raccord_out": ""}}
Rules: every shot id must appear in exactly one sequence, in its original order, covering all shots. S1 gets the
opening shots (the hook, strongest in the first 3s). S3 gets the closing shots (cliffhanger). Each sequence
should total close to 30 seconds by summing its shots' durations — trade shots between sequences to get close,
never split a shot. Tag S2 "key" instead of "normal" only if its shots contain a twist/reveal/confrontation.
raccord_in/raccord_out are short notes on how each sequence should visually open/close to match its neighbour."""

PREPROD_SYS = """You are a production coordinator. From the screenplay and shot list, propose the Reference
Bank's characters, environments and props for a photoreal vertical 9:16 microdrama. Return ONLY one JSON object:
{"characters": [{"name": str, "desc": "English: age, look, wardrobe, personality"}],
 "environments": [{"name": str, "tag": "INT"|"EXT", "time": "day"|"night", "desc": "English set description: light, palette, key dressing"}],
 "props": [{"name": str, "desc": "English one-line description"}]}
Only include characters/props/locations that actually appear in the material. Keep descriptions short (1-2
sentences), specific, and filmable."""

REWRITE_SYS = """You turn a short user request (Vietnamese or English) for editing ONE existing AI-generated
image into a precise ENGLISH image-edit instruction for an image-edit model. Always state that identity/face,
aspect ratio and background must stay unchanged except for what the user asked to change. Be concrete and
literal; do not add creative flourishes the user did not ask for. Output the instruction as plain text only,
one paragraph, no preamble, no quotes."""

CRITIQUE_SYS = """You look at one reference image for an AI video production (a character sheet, an environment
still, a prop, or a storyboard frame) and list concrete problems only: a missing angle on a sheet, a background
that is not solid white, a malformed hand, an inconsistent face, wrong lighting, anything that would break
downstream generation. If nothing is wrong, say so in one sentence. Plain English text, a short bullet list."""

PROMPT_SYS = """You write ONE Seedance Omni Reference prompt in ENGLISH for a single AI video generation, following
this exact structure (Seedance 2.5/2.0 reference-to-video master formula):
[Creatives Description]
[One-sentence Summary]: Subject + Location + Event + Theme/Style + Special camera movement.
[Plot per timestamp]: for each beat, "[a-b s] picture + camera + action + dialogue + SFX".
[Global supplement]: repeat camera position, environment features, sound/atmosphere, lighting.
Module 1 (reference layer) MUST come first and cite the exact @Image/@Audio/@Video numbers given to you, e.g.
"Based on the uploaded references, strictly maintain the face and features of @Image1 for <name>, the composition
and space of @Image2, the voice timbre of @Audio1 for <name>; strictly lock character positions."
NEVER invent a reference number yourself — only use the numbers given in the mapping. Always end with this
prohibited-items line, verbatim: "Prohibited: """ + PROHIBITED + """."
Output plain text only, no markdown fences, no JSON."""

REVIEW_SYS = """You review one Seedance video prompt against its sequence JSON (characters, props, beats, dialogue,
raccord notes) for a US vertical microdrama. Return ONLY one JSON object:
{"pass": true|false, "notes": "short English notes: missing beats, wrong @Image/@Audio numbers, dialogue drift,
raccord mismatch, or empty string if it fully matches"}"""


class Lock:
    def __init__(self):
        self._l = threading.RLock()

    def __enter__(self):
        self._l.acquire()

    def __exit__(self, *a):
        self._l.release()


LOCK = Lock()
STATE = {}
KEYS = {}
RUNNING = set()
SOLO = {}


def ts():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def scrub(text):
    s = str(text)
    for v in list(KEYS.values()):
        if v and len(v) > 6:
            s = s.replace(v, "***")
    return s


def log(msg):
    msg = scrub(msg)
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(f"{ts()} {msg}\n")
    except OSError:
        pass


def load_keys():
    keys = {}
    for name in ("keys.txt", ".env"):
        p = HERE / name
        if not p.exists():
            continue
        for line in p.read_text(encoding="utf-8-sig").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            v = v.strip().strip('"').strip("'")
            if v and k.strip() not in keys:
                keys[k.strip()] = v
    return keys


def ensure_keys_file():
    p = HERE / "keys.txt"
    if not p.exists():
        p.write_text("WAVESPEED_API_KEY=\nATLASCLOUD_API_KEY=\nBUDGET_USD=18\n", encoding="utf-8")


def budget():
    try:
        return float(KEYS.get("BUDGET_USD", "18"))
    except ValueError:
        return 18.0


def slug(s, n=20):
    s = re.sub(r"[^a-z0-9]+", "_", str(s or "").lower()).strip("_")
    return s[:n] or "x"


def fresh_state():
    return {"v": 2, "created": ts(), "project": {"name": "DuAn", "episode": 1}, "script": "", "style": "",
            "shots_raw": "", "shots": [], "shots_v": 0,
            "chars": {}, "envs": {}, "props": {}, "voices": {}, "video_refs": {},
            "seq": {}, "seq_v": 0, "prompts": {}, "qc": {}, "fixes": {}, "chats": {}, "llm_vision_ok": True,
            "settings": dict(DEFAULT_SETTINGS), "jobs": {}, "picks": {}, "job_n": 0, "asset_v": {},
            "balance": {}, "export": {}}


def load_state():
    if STATE_FILE.exists():
        st = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        for k, v in fresh_state().items():
            st.setdefault(k, v)
        for k, v in DEFAULT_SETTINGS.items():
            st["settings"].setdefault(k, v)
        return st
    return fresh_state()


def save():
    with LOCK:
        OUT.mkdir(exist_ok=True)
        tmp = STATE_FILE.with_name("state.tmp")
        tmp.write_text(json.dumps(STATE, ensure_ascii=False, indent=1), encoding="utf-8")
        import os
        os.replace(tmp, STATE_FILE)


def ledger(job, event, amount):
    new = not LEDGER.exists()
    try:
        with open(LEDGER, "a", newline="", encoding="utf-8-sig" if new else "utf-8") as f:
            w = csv.writer(f)
            if new:
                w.writerow(["thời gian", "việc", "model", "số lượng", "đơn giá USD", "USD", "sự kiện"])
            w.writerow([ts(), job["id"], job.get("model"), job.get("units"), job.get("unit_price"),
                        round(amount, 4), event])
    except OSError as e:
        log(f"Không ghi được so_chi.csv ({e}) — file đang mở trong Excel?")


def S():
    return STATE["settings"]


# ---------------------------------------------------------------- naming (spec §6)
def proj_name():
    return slug(STATE["project"]["name"], 40) or "DuAn"


def ep_no():
    try:
        return int(STATE["project"].get("episode", 1))
    except (TypeError, ValueError):
        return 1


def project_dir():
    d = PROJECTS / proj_name()
    d.mkdir(parents=True, exist_ok=True)
    return d


def next_version(scope):
    v = STATE["asset_v"].get(scope, 0) + 1
    STATE["asset_v"][scope] = v
    return v


def asset_dest(sub, filename):
    d = project_dir() / sub
    d.mkdir(parents=True, exist_ok=True)
    return d / filename


NAMING = {
    "portrait": ("01_PreProduction/03_Character", "Char_{name}_{label}_{res}_v{v}{ext}"),
    "sheet": ("01_PreProduction/03_Character", "Char_{name}_sheet21x9_{res}_v{v}{ext}"),
    "component": ("01_PreProduction/03_Character", "Char_{name}_component_{label}_v{v}{ext}"),
    "env_wide": ("01_PreProduction/02_Environment", "Envi_{name}_{label}_{res}_v{v}{ext}"),
    "env_rev": ("01_PreProduction/02_Environment", "Envi_{name}_{label}_rev_{res}_v{v}{ext}"),
    "prop": ("01_PreProduction/05_Prop", "Prop_{name}_{res}_v{v}{ext}"),
    "voice": ("01_PreProduction/06_Voice", "Voice_{name}_v{v}{ext}"),
    "video_ref": ("01_PreProduction/04_VideoRef", "Video_Ref_{name}_v{v}{ext}"),
    "frame": ("02_Production/frames", "Frame_{name}_v{v}{ext}"),
    "fix_img": ("02_Production/frames", "Fix_{name}_v{v}{ext}"),
    "storyboard": ("02_Production/storyboard", "Storyboard_{name}_v{v}{ext}"),
    "gen": (None, "{proj}_EP{ep:02d}_Video_{name}_v{v}{ext}"),
    "patch": (None, "{proj}_EP{ep:02d}_Video_{name}_patch_{a}-{b}s_v{v}{ext}"),
}


def make_filename(kind, v, ext, name="", label="", extra=None):
    sub, tmpl = NAMING[kind]
    extra = extra or {}
    fn = tmpl.format(name=slug(name, 24), label=slug(label, 16) or "x", res=S().get("image_resolution", "2k").upper(),
                      v=v, ext=ext, proj=proj_name(), ep=ep_no(), **extra)
    if sub is None:
        sub = f"02_Production/EP{ep_no():02d}"
    return sub, fn


# ---------------------------------------------------------------- reference bank
def _new_id(bank, prefix):
    n = 1
    while f"{prefix}{n}" in STATE[bank]:
        n += 1
    return f"{prefix}{n}"


def new_char(name, desc="", approved=True):
    cid = _new_id("chars", "char_")
    STATE["chars"][cid] = {"id": cid, "name": name or cid, "desc": desc, "components": [], "approved": approved}
    save()
    return STATE["chars"][cid]


def new_env(name, tag="EXT", time_of_day="day", desc="", approved=True):
    eid = _new_id("envs", "env_")
    STATE["envs"][eid] = {"id": eid, "name": name or eid, "tag": tag if tag in ("INT", "EXT") else "EXT",
                          "time": time_of_day if time_of_day in ("day", "night") else "day", "text": desc,
                          "approved": approved}
    save()
    return STATE["envs"][eid]


def new_prop(name, desc="", approved=True):
    pid = _new_id("props", "prop_")
    STATE["props"][pid] = {"id": pid, "name": name or pid, "desc": desc, "approved": approved}
    save()
    return STATE["props"][pid]


def apply_preprod(data):
    """Merge a GPT-proposed pre-production list into the bank; new items land not-approved for owner review."""
    by_name = lambda bank: {v["name"].lower(): v for v in STATE[bank].values()}
    chars = by_name("chars")
    for c in data.get("characters") or []:
        name = str(c.get("name") or "").strip()
        if not name:
            continue
        if name.lower() in chars:
            chars[name.lower()]["desc"] = chars[name.lower()]["desc"] or str(c.get("desc") or "")
        else:
            new_char(name, str(c.get("desc") or ""), approved=False)
    envs = by_name("envs")
    for e in data.get("environments") or []:
        name = str(e.get("name") or "").strip()
        if not name:
            continue
        if name.lower() in envs:
            envs[name.lower()]["text"] = envs[name.lower()]["text"] or str(e.get("desc") or "")
        else:
            new_env(name, str(e.get("tag") or "EXT").upper(), str(e.get("time") or "day"), str(e.get("desc") or ""), approved=False)
    props = by_name("props")
    for p in data.get("props") or []:
        name = str(p.get("name") or "").strip()
        if not name:
            continue
        if name.lower() not in props:
            new_prop(name, str(p.get("desc") or ""), approved=False)
    save()


def new_voice(name, char=""):
    vid = _new_id("voices", "voice_")
    STATE["voices"][vid] = {"id": vid, "name": name or vid, "char": char if char in STATE["chars"] else ""}
    save()
    return STATE["voices"][vid]


def set_approved(bank, id_, approved):
    if bank not in ("chars", "envs", "props") or id_ not in STATE[bank]:
        raise ValueError("Không có mục này.")
    STATE[bank][id_]["approved"] = bool(approved)
    save()


def new_video_ref(name):
    rid = _new_id("video_refs", "ref_")
    STATE["video_refs"][rid] = {"id": rid, "name": name or rid}
    save()
    return STATE["video_refs"][rid]


def add_component(char_id, data, ext, label, source, use):
    if char_id not in STATE["chars"]:
        raise ValueError("Không có nhân vật này.")
    if source not in ("ai", "real"):
        raise ValueError("source phải là ai hoặc real.")
    if use not in COMPONENT_USES:
        raise ValueError("use không hợp lệ: " + use)
    if source == "real" and use in ("face", "eyes"):
        raise ValueError("Không dùng ảnh người thật cho mặt/mắt (hard rule: chỉ mặt AI).")
    c = STATE["chars"][char_id]
    v = next_version(f"component:{char_id}")
    sub, fn = make_filename("component", v, ext, name=c["name"], label=label)
    dest = asset_dest(sub, fn)
    dest.write_bytes(data)
    comp = {"id": f"c{v}", "file": str(dest.relative_to(HERE)), "label": label, "source": source, "use": use,
            "created": ts(), "url": None}
    STATE["chars"][char_id]["components"].append(comp)
    save()
    log(f"Thêm component {use}/{source} cho {char_id}: {label}")
    return comp


def remove_component(char_id, comp_id):
    c = STATE["chars"].get(char_id)
    if not c:
        return
    c["components"] = [x for x in c["components"] if x["id"] != comp_id]
    save()


# ---------------------------------------------------------------- job engine (takes / picks / money)
def takes(kind, target):
    return sorted((j for j in STATE["jobs"].values() if j["kind"] == kind and j["target"] == target),
                  key=lambda j: j["take"])


def pick(kind, target):
    ts_ = takes(kind, target)
    chosen = STATE["picks"].get(f"{kind}:{target}")
    for j in ts_:
        if j["id"] == chosen and j["status"] == "done":
            return j
    done = [j for j in ts_ if j["status"] == "done"]
    return done[-1] if done else None


def in_progress(kind, target):
    return any(j["status"] in ("queued", "starting", "running") for j in takes(kind, target))


def live_takes(kind, target):
    return [j for j in takes(kind, target) if j["status"] not in ("failed", "cancelled")]


def model_measured(model):
    return any(j.get("measured") for j in STATE["jobs"].values() if j.get("model") == model)


def money():
    spent = reserved = 0.0
    for j in STATE["jobs"].values():
        st = j["status"]
        if st in ("queued", "starting"):
            reserved += j["est"]
        elif st == "running":
            spent += j.get("cost", 0) if j.get("pid") else 0
            reserved += 0 if j.get("pid") else j["est"]
        elif st in ("done", "stalled"):
            spent += j.get("cost", 0)
    return round(spent, 4), round(reserved, 4)


def llm_est(pin, pout, prompt_chars, out_tokens):
    return prompt_chars / 3.5 / 1e6 * pin + out_tokens / 1e6 * pout


def _new_job(kind, target, provider, model, units, unit_price, label, extra=None):
    STATE["job_n"] += 1
    take = 1 + max([j["take"] for j in STATE["jobs"].values() if j["kind"] == kind and j["target"] == target] or [0])
    jid = f"{kind}:{target}:t{take}"
    est = round(units * unit_price, 4)
    job = dict(id=jid, n=STATE["job_n"], kind=kind, target=target, take=take, provider=provider, model=model,
               units=units, unit_price=unit_price, est=est, cost=0.0, status="queued", created=ts(), label=label)
    job.update(extra or {})
    STATE["jobs"][jid] = job
    return job


def register_local(kind, target, path, provider="local", meta=None):
    """A file the owner uploaded (or ffmpeg produced): free, instant, same take/pick machinery as generated jobs."""
    with LOCK:
        job = _new_job(kind, target, provider, None, 1, 0.0, f"{STAGE_NAME.get(kind, kind)} ({target})", meta)
        job.update(status="done", cost=0.0, file=str(Path(path).relative_to(HERE)) if path else None, t_end=ts())
        STATE["picks"][f"{kind}:{target}"] = job["id"]
    save()
    ledger(job, "tải lên", 0)
    return job


def probe_duration(path):
    ff = shutil.which("ffprobe")
    if not ff:
        return None
    try:
        r = subprocess.run([ff, "-v", "error", "-show_entries", "format=duration", "-of",
                            "default=noprint_wrappers=1:nokey=1", str(path)], capture_output=True, text=True, timeout=20)
        return round(float(r.stdout.strip()), 1)
    except Exception:
        return None


_BANK_NAME = {"portrait": "chars", "sheet": "chars", "env_wide": "envs", "env_rev": "envs", "prop": "props",
              "voice": "voices", "video_ref": "video_refs"}


def upload_asset(kind, target, data, ext, label=""):
    """Owner-supplied file for a single-pick slot (portrait/sheet/env/prop/voice/video_ref) — no API call, no cost."""
    bank = _BANK_NAME.get(kind)
    if not bank or target not in STATE[bank]:
        raise ValueError("Không có mục này trong Tham chiếu.")
    v = 1 + len(takes(kind, target))
    sub, fn = make_filename(kind, v, ext, name=STATE[bank][target]["name"], label=label)
    dest = asset_dest(sub, fn)
    dest.write_bytes(data)
    meta = {}
    if kind in ("voice", "video_ref"):
        dur = probe_duration(dest)
        if dur is not None:
            meta["dur"] = dur
    return register_local(kind, target, dest, meta=meta or None)


# ---------------------------------------------------------------- sequences / mapping / prompts
def normalize_shots(raw):
    if not isinstance(raw, dict):
        raise ValueError("Shot list phải là JSON object.")
    shots = []
    for i, s in enumerate(raw.get("shots") or []):
        if not isinstance(s, dict):
            continue
        sid = str(s.get("id") or f"SH{i + 1:02d}").strip() or f"SH{i + 1:02d}"
        try:
            dur = max(4, min(15, int(round(float(s.get("duration") or 6)))))
        except (TypeError, ValueError):
            dur = 6
        old = shot_by_id(sid) or {}
        shots.append({"id": sid, "duration": dur, "location": str(s.get("location") or "").strip(),
                      "cast": [str(x).strip() for x in (s.get("cast") or []) if str(x).strip()],
                      "props": [str(x).strip() for x in (s.get("props") or []) if str(x).strip()],
                      "desc": str(s.get("desc") or "").strip(), "speaker": str(s.get("speaker") or "").strip(),
                      "line": str(s.get("line") or "").strip(), "storyboard_on": bool(old.get("storyboard_on", False))})
    if not shots:
        raise ValueError("Shot list không có shot nào.")
    return shots


def shot_by_id(sid):
    return next((s for s in STATE["shots"] if s["id"] == sid), None)


def derive_seq_from_shots(shot_ids):
    shots = [shot_by_id(x) for x in shot_ids if shot_by_id(x)]
    counts = {}
    for s in shots:
        if s["location"]:
            counts[s["location"]] = counts.get(s["location"], 0) + 1
    location = max(counts, key=counts.get) if counts else ""
    chars, props = [], []
    beats, lines, t = [], [], 0
    for s in shots:
        for c in s["cast"]:
            if c not in chars:
                chars.append(c)
        for p in s["props"]:
            if p not in props:
                props.append(p)
        beats.append({"t0": t, "t1": t + s["duration"], "action": s["desc"], "shot": s["id"]})
        if s["line"]:
            lines.append({"speaker": s["speaker"], "text": s["line"], "t": t})
        t += s["duration"]
    return {"location": location, "characters": chars, "props": props, "beats": beats, "lines": lines,
            "time_range": [0, t], "video_refs": []}


def normalize_seq(raw):
    if not isinstance(raw, dict):
        raise ValueError("Sequences phải là JSON object.")
    out = {}
    for k in ("S1", "S2", "S3"):
        s = raw.get(k)
        if not isinstance(s, dict):
            raise ValueError(f"Thiếu {k}.")
        tag = str(s.get("tag") or DEFAULT_TAG[k]).strip().lower()
        if k == "S1":
            tag = "hook"
        elif k == "S3":
            tag = "cliffhanger"
        elif tag not in ("normal", "key"):
            tag = "normal"
        shot_ids = [str(x).strip() for x in (s.get("shot_ids") or []) if str(x).strip()]
        if shot_ids and STATE["shots"]:
            derived = derive_seq_from_shots(shot_ids)
        else:
            tr = s.get("time_range") or [0, 30]
            try:
                tr = [int(tr[0]), int(tr[1])]
            except (TypeError, ValueError, IndexError):
                tr = [0, 30]
            beats = []
            for b in s.get("beats") or []:
                if not isinstance(b, dict):
                    continue
                try:
                    t0, t1 = int(b.get("t0", 0)), int(b.get("t1", 0))
                except (TypeError, ValueError):
                    continue
                beats.append({"t0": t0, "t1": t1, "action": str(b.get("action") or "").strip()})
            lines = []
            for l in s.get("lines") or []:
                if not isinstance(l, dict) or not l.get("text"):
                    continue
                try:
                    t = int(l.get("t", 0))
                except (TypeError, ValueError):
                    t = 0
                lines.append({"speaker": str(l.get("speaker") or "").strip(), "text": str(l.get("text") or "").strip(), "t": t})
            derived = {"time_range": tr, "location": str(s.get("location") or "").strip(),
                       "characters": [str(x).strip() for x in (s.get("characters") or []) if str(x).strip()],
                       "props": [str(x).strip() for x in (s.get("props") or []) if str(x).strip()],
                       "beats": beats, "lines": lines,
                       "video_refs": [str(x).strip() for x in (s.get("video_refs") or []) if str(x).strip()]}
        out[k] = dict(derived, tag=tag, shot_ids=shot_ids,
                      raccord_in=str(s.get("raccord_in") or "").strip(),
                      raccord_out=str(s.get("raccord_out") or "").strip(),
                      use_storyboards=bool(s.get("use_storyboards", True)))
    return out


def parse_json(text):
    t = text.strip()
    if t.startswith("```"):
        t = re.sub(r"^```[a-zA-Z]*\s*|\s*```$", "", t)
    try:
        return json.loads(t)
    except ValueError:
        a, b = t.find("{"), t.rfind("}")
        if a >= 0 and b > a:
            return json.loads(t[a:b + 1])
        raise


def half_beats(seq, gen):
    """S2a = first 15s of S2, S2b = second 15s. S1/S3 use the whole sequence."""
    if gen not in ("S2a", "S2b"):
        return seq["beats"], seq["lines"]
    lo, hi = (0, 15) if gen == "S2a" else (15, 30)
    beats = [b for b in seq["beats"] if b["t0"] < hi and b["t1"] > lo]
    lines = [l for l in seq["lines"] if lo <= l["t"] < hi]
    return beats, lines


def char_name(cid_or_name):
    c = STATE["chars"].get(cid_or_name)
    if c:
        return c["name"]
    for c in STATE["chars"].values():
        if c["name"].lower() == str(cid_or_name).lower():
            return c["name"]
    return cid_or_name


def _find_char(name):
    for c in STATE["chars"].values():
        if c["id"] == name or c["name"].lower() == str(name).lower():
            return c
    return None


def _find_env(name):
    for e in STATE["envs"].values():
        if e["id"] == name or e["name"].lower() == str(name).lower():
            return e
    return None


def _find_prop(name):
    for p in STATE["props"].values():
        if p["id"] == name or p["name"].lower() == str(name).lower():
            return p
    return None


def build_mapping(gen):
    """Ordered @Image/@Video/@Audio list for one generation, plus the text the LLM is given (never guesses numbers)."""
    seqk = SEQ_OF[gen]
    seq = STATE["seq"].get(seqk)
    if not seq:
        raise ApiError(f"Chưa có sequence {seqk} (bước Sequences).")
    images, videos, audios, lines_txt = [], [], [], []
    for cname in seq["characters"]:
        c = _find_char(cname)
        if not c:
            continue
        sheet = pick("sheet", c["id"])
        if sheet:
            images.append(("char_sheet", c["id"], sheet))
            lines_txt.append(f"@Image{len(images)} = Char_{c['name']} sheet 21:9 for {c['name']}")
        for v in STATE["voices"].values():
            if v["char"] == c["id"]:
                vj = pick("voice", v["id"])
                if vj:
                    audios.append(("voice", v["id"], vj))
                    lines_txt.append(f"@Audio{len(audios)} = voice timbre of {c['name']}")
    env = _find_env(seq["location"])
    if env:
        wide = pick("env_wide", env["id"])
        if wide:
            images.append(("env_wide", env["id"], wide))
            lines_txt.append(f"@Image{len(images)} = Envi_{env['name']} establishing shot")
    for pname in seq["props"]:
        p = _find_prop(pname)
        if p:
            pj = pick("prop", p["id"])
            if pj:
                images.append(("prop", p["id"], pj))
                lines_txt.append(f"@Image{len(images)} = Prop_{p['name']}")
    for rname in seq["video_refs"]:
        r = new_video_ref(rname) if not any(v["name"].lower() == rname.lower() for v in STATE["video_refs"].values()) \
            else next(v for v in STATE["video_refs"].values() if v["name"].lower() == rname.lower())
        rj = pick("video_ref", r["id"])
        if rj:
            videos.append(("video_ref", r["id"], rj))
            lines_txt.append(f"@Video{len(videos)} = motion/camera reference: {r['name']}")
    if seq.get("use_storyboards", True):
        beats_half, _ = half_beats(seq, gen)
        for b in beats_half:
            sid = b.get("shot")
            sbj = sid and pick("storyboard", sid)
            if sbj:
                images.append(("storyboard", sid, sbj))
                lines_txt.append(f"@Image{len(images)} = storyboard for shot {sid} — composition/pose reference only, keep the face from the character sheet")
    if gen == "S2b":
        s2a = pick("gen", "S2a")
        if s2a and s2a.get("last_frame"):
            images.append(("last_frame", "S2a", s2a))
            lines_txt.append(f"@Image{len(images)} = last frame of S2a (raccord continuity)")
    return {"images": images, "videos": videos, "audios": audios, "text": "\n".join(lines_txt)}


def img_url(entry):
    """entry = (kind, id, job). A last_frame reference already has a provider URL; everything else may be local."""
    kind, _id, j = entry
    return j["last_frame"] if kind == "last_frame" else url_of(j)


def url_of(job):
    """A local-only asset (owner upload, ffmpeg frame) needs a public URL before Atlas/Nano Banana can use it."""
    if job.get("url"):
        return job["url"]
    if not job.get("file"):
        raise ApiError(f"{job['id']} chưa có file để dùng làm tham chiếu.")
    ws = ws_client()
    url = ws.upload_local(HERE / job["file"])
    job["url"] = url
    save()
    return url


# ---------------------------------------------------------------- providers wiring
def key_for(provider):
    k = KEYS.get(KEY_OF[provider], "")
    if not k:
        raise ApiError(f"Chưa có {KEY_OF[provider]} trong keys.txt.")
    return k


def ws_client():
    return providers.WaveSpeed(WS_BASE, WS_LLM_BASE, key_for("wavespeed"))


def atlas_client():
    return providers.Atlas(ATLAS_BASE, ATLAS_PUB_BASE, key_for("atlas"))


def read_balance(provider):
    key = KEYS.get(KEY_OF[provider])
    if not key:
        return None
    try:
        if provider == "wavespeed":
            return providers.WaveSpeed(WS_BASE, WS_LLM_BASE, key).balance()
        return providers.Atlas(ATLAS_BASE, ATLAS_PUB_BASE, key).balance()
    except Exception as e:
        log(f"Không đọc được số dư {PROVIDER_NAME[provider]}: {e}")
        return None


def refresh_balances(reset_start=False):
    for p in KEY_OF:
        v = read_balance(p)
        if v is None:
            continue
        with LOCK:
            b = STATE["balance"].setdefault(p, {})
            if reset_start or b.get("start") is None:
                b["start"] = v
                b["start_t"] = ts()
            b["now"] = v
            b["t"] = ts()
    save()


# ---------------------------------------------------------------- job specs (what a stage would run)
def specs_for(stage, target=None, redo=False):
    st = S()
    if stage == "style":
        if not STATE["script"].strip():
            return [], "Chưa có kịch bản."
        est = llm_est(st["llm_write_in"], st["llm_write_out"], len(STYLE_SYS) + len(STATE["script"]), 900)
        return [dict(kind="style", target="ep", provider="wavespeed", model=st["llm_write"], units=1,
                     unit_price=round(est, 4), label="Phân tích style")], None
    if stage == "shots":
        if not STATE["script"].strip() and not STATE["shots_raw"].strip():
            return [], "Chưa có kịch bản hoặc shot list."
        est = llm_est(st["llm_write_in"], st["llm_write_out"], len(SHOTS_SYS) + len(STATE["script"]) + len(STATE["shots_raw"]), 2600)
        return [dict(kind="shots", target="ep", provider="wavespeed", model=st["llm_write"], units=1,
                     unit_price=round(est, 4), label="Chuẩn hoá/tạo shot list")], None
    if stage == "seq":
        if not STATE["shots"]:
            return [], "Chưa có shot list (bước Sequences: dán hoặc tạo shot list trước)."
        est = llm_est(st["llm_write_in"], st["llm_write_out"], len(SEQ_SYS) + len(json.dumps(STATE["shots"])), 1200)
        return [dict(kind="seq", target="ep", provider="wavespeed", model=st["llm_write"], units=1,
                     unit_price=round(est, 4), label="Chia sequences")], None
    if stage == "preprod":
        if not STATE["script"].strip() and not STATE["shots"]:
            return [], "Chưa có kịch bản hoặc shot list."
        est = llm_est(st["llm_write_in"], st["llm_write_out"], len(PREPROD_SYS) + len(STATE["script"]) + len(json.dumps(STATE["shots"])), 1400)
        return [dict(kind="preprod", target="ep", provider="wavespeed", model=st["llm_write"], units=1,
                     unit_price=round(est, 4), label="Đề xuất danh sách tiền kỳ")], None
    if stage == "refs_all":
        out = []
        for sub in ("portrait", "sheet", "env_wide", "prop"):
            specs, err = specs_for(sub, None, redo)
            if err and not out:
                continue
            out.extend(specs)
        return out, None
    if stage == "portrait":
        out = []
        for c in STATE["chars"].values():
            if target and c["id"] != target:
                continue
            if not c.get("approved", True):
                if target:
                    return [], f"{c['name']}: chưa được duyệt trong Tham chiếu."
                continue
            if not redo and live_takes("portrait", c["id"]):
                continue
            if not c["components"]:
                if target:
                    return [], f"{c['name']}: chưa có ảnh thành phần nào."
                continue
            out.append(dict(kind="portrait", target=c["id"], provider="wavespeed", model="google/nano-banana-pro/edit",
                             units=1, unit_price=IMAGE_PRICE[st["image_resolution"]], label=f"Ảnh nhân vật {c['name']}"))
        return out, None
    if stage == "sheet":
        out = []
        for c in STATE["chars"].values():
            if target and c["id"] != target:
                continue
            if not redo and live_takes("sheet", c["id"]):
                continue
            if not pick("portrait", c["id"]) and not in_progress("portrait", c["id"]):
                if target:
                    return [], f"{c['name']}: chưa có ảnh nhân vật được duyệt."
                continue
            out.append(dict(kind="sheet", target=c["id"], provider="wavespeed", model="google/nano-banana-pro/edit",
                             units=1, unit_price=IMAGE_PRICE[st["sheet_resolution"]], label=f"Sheet 21:9 {c['name']}"))
        return out, None
    if stage in ("env_wide", "env_rev"):
        out = []
        for e in STATE["envs"].values():
            if target and e["id"] != target:
                continue
            if not e.get("approved", True):
                if target:
                    return [], f"{e['name']}: chưa được duyệt trong Tham chiếu."
                continue
            if not redo and live_takes(stage, e["id"]):
                continue
            if not e["text"].strip():
                if target:
                    return [], f"{e['name']}: chưa có mô tả bối cảnh."
                continue
            out.append(dict(kind=stage, target=e["id"], provider="wavespeed", model="google/nano-banana-pro/text-to-image",
                             units=1, unit_price=IMAGE_PRICE[st["image_resolution"]],
                             label=("Ảnh bối cảnh " if stage == "env_wide" else "Bối cảnh góc ngược ") + e["name"]))
        return out, None
    if stage == "prop":
        out = []
        for p in STATE["props"].values():
            if target and p["id"] != target:
                continue
            if not p.get("approved", True):
                if target:
                    return [], f"{p['name']}: chưa được duyệt trong Tham chiếu."
                continue
            if not redo and live_takes("prop", p["id"]):
                continue
            out.append(dict(kind="prop", target=p["id"], provider="wavespeed", model="google/nano-banana-pro/text-to-image",
                             units=1, unit_price=IMAGE_PRICE[st["image_resolution"]], label=f"Ảnh prop {p['name']}"))
        return out, None
    if stage == "storyboard":
        out = []
        for sh in STATE["shots"]:
            if target and sh["id"] != target:
                continue
            if not sh.get("storyboard_on"):
                if target:
                    return [], f"{sh['id']}: chưa bật storyboard cho shot này."
                continue
            if not redo and live_takes("storyboard", sh["id"]):
                continue
            missing = [c for c in sh["cast"] if not pick("sheet", (_find_char(c) or {}).get("id", "")) and not in_progress("sheet", (_find_char(c) or {}).get("id", ""))]
            if missing:
                if target:
                    return [], f"{sh['id']}: thiếu sheet nhân vật {', '.join(missing)}."
                continue
            model = st["storyboard_model"]
            price = st["storyboard_price"] if "seedream" in model else IMAGE_PRICE.get(st["image_resolution"], 0.14)
            out.append(dict(kind="storyboard", target=sh["id"], provider="wavespeed", model=model, units=1,
                             unit_price=price, label=f"Storyboard {sh['id']}"))
        return out, None
    if stage == "critique":
        if not STATE.get("llm_vision_ok", True):
            return [], "LLM không nhận ảnh — đã ẩn nút này."
        kind, tgt = (target or "").split(":", 1) if target and ":" in target else (None, None)
        if not kind or not pick(kind, tgt):
            return [], "Chưa có ảnh để nhận xét."
        est = llm_est(st["llm_review_in"], st["llm_review_out"], len(CRITIQUE_SYS), 300)
        return [dict(kind="critique", target=target, provider="wavespeed", model=st["llm_review"], units=1,
                     unit_price=round(est, 4), label=f"Nhận xét ảnh {target}")], None
    if stage in ("prompt", "review"):
        out = []
        for gen in GENS:
            if target and gen != target:
                continue
            if not redo and live_takes(stage, gen):
                continue
            if stage == "review" and not STATE["prompts"].get(gen, {}).get("text"):
                if target:
                    return [], f"{gen}: chưa có prompt."
                continue
            price_in, price_out = (st["llm_write_in"], st["llm_write_out"]) if stage == "prompt" else (st["llm_review_in"], st["llm_review_out"])
            model = st["llm_write"] if stage == "prompt" else st["llm_review"]
            est = llm_est(price_in, price_out, 1800, 900)
            out.append(dict(kind=stage, target=gen, provider="wavespeed", model=model, units=1, unit_price=round(est, 4),
                             label=(STAGE_NAME[stage]) + " " + gen))
        return out, None
    if stage == "gen":
        out = []
        for gen in GENS:
            if target and gen != target:
                continue
            if not redo and live_takes("gen", gen):
                continue
            if not STATE["prompts"].get(gen, {}).get("approved"):
                if target:
                    return [], f"{gen}: prompt chưa được duyệt."
                continue
            if gen == "S2b" and not (pick("gen", "S2a") and pick("gen", "S2a").get("last_frame")):
                if target:
                    return [], "S2b cần khung hình cuối của S2a trước (chờ S2a xong)."
                continue
            model, price = st["video_" + gen], float(st["price_" + gen])
            spec = dict(kind="gen", target=gen, provider="atlas", model=model, units=DURATION[gen],
                        unit_price=price, label=f"Sinh video {gen} · {DURATION[gen]}s")
            if not model_measured(model):
                spec["measure"] = True
                spec["label"] += " · đo giá thật lần đầu"
            out.append(spec)
        return out, None
    if stage == "fix_img":
        f = STATE["fixes"].get(target)
        if not f:
            return [], "Không có fix này."
        if not redo and live_takes("fix_img", target):
            return [], None
        return [dict(kind="fix_img", target=target, provider="wavespeed", model="google/nano-banana-pro/edit",
                     units=1, unit_price=IMAGE_PRICE[S()["image_resolution"]], label=f"Ảnh sửa {target}")], None
    if stage == "patch":
        f = STATE["fixes"].get(target)
        if not f:
            return [], "Không có fix này."
        if not pick("fix_img", target) and not in_progress("fix_img", target):
            return [], f"{target}: chưa có ảnh sửa được duyệt."
        if not redo and live_takes("patch", target):
            return [], None
        gen = f["gen"]
        dur = max(4, min(10, f["end"] - f["start"]))
        model, price = S()["video_" + gen], float(S()["price_" + gen])
        return [dict(kind="patch", target=target, provider="atlas", model=model, units=dur, unit_price=price,
                     label=f"Vá {gen} {f['start']}-{f['end']}s")], None
    return [], "Bước không hợp lệ."


def create_chat_job(kind, target, text, model, resolution, attachments=None, dry=False):
    with LOCK:
        if kind not in EDITABLE_IMAGE_KINDS:
            return {"error": "Không sửa được loại ảnh này."}
        base = pick(kind, target)
        if not base:
            return {"error": "Chưa có ảnh nào để sửa — tạo hoặc tải ảnh gốc trước."}
        if not text.strip():
            return {"error": "Chưa gõ yêu cầu sửa."}
        if not KEYS.get(KEY_OF["wavespeed"]):
            return {"error": "Chưa có WAVESPEED_API_KEY trong keys.txt."}
        edits = [j for j in takes(kind, target) if j.get("edit") and j["status"] not in ("failed", "cancelled")]
        limit = int(S().get("max_edits_per_image", 10))
        if len(edits) >= limit:
            return {"error": f"Đã sửa {limit} lần cho ảnh này (giới hạn trong Cài đặt)."}
        price = image_price_for(model, resolution)
        if dry:
            return {"n": 1, "est": price, "items": [f"Sửa ảnh ({model}) · ~${price:.3f}"]}
        spent, reserved = money()
        if spent + reserved + price > budget() + 1e-9:
            return {"error": f"Vượt trần: đã chi ~${spent:.2f} + đang chờ ~${reserved:.2f} + lần này ~${price:.3f} > trần ${budget():.2f}."}
        chat_key = f"{kind}:{target}"
        STATE["chats"].setdefault(chat_key, []).append({"role": "user", "text": text, "attachments": attachments or [], "t": ts()})
        job = _new_job(kind, target, "wavespeed", model, 1, price, f"Sửa ảnh {kind}:{target}",
                       {"edit": True, "chat_text": text, "resolution": resolution, "base_take": base["id"], "attachments": attachments or []})
        save()
        return {"ok": True, "job": job["id"]}


def create_chat_attachment(data, ext, label, source, use):
    if source not in ("ai", "real"):
        raise ValueError("source phải là ai hoặc real.")
    if use not in COMPONENT_USES:
        raise ValueError("use không hợp lệ: " + use)
    if source == "real" and use in ("face", "eyes"):
        raise ValueError("Không dùng ảnh người thật cho mặt/mắt (hard rule: chỉ mặt AI).")
    aid = f"attach_{STATE['job_n'] + 1}"
    sub, fn = "02_Production/chat_attach", f"Attach_{slug(label, 20)}_{aid}{ext}"
    dest = asset_dest(sub, fn)
    dest.write_bytes(data)
    job = register_local("chat_attach", aid, dest, meta={"label": label, "source": source, "use": use})
    return job


def create_jobs(stage, target=None, redo=False, dry=False):
    with LOCK:
        specs, err = specs_for(stage, target, redo)
        if err:
            return {"error": err}
        for sp in specs:
            if not KEYS.get(KEY_OF[sp["provider"]]):
                return {"error": f"Chưa có {KEY_OF[sp['provider']]} trong keys.txt."}
        if redo and target and stage == "gen":
            limit = int(S().get("max_full_gens", 2))
            if len(live_takes("gen", target)) >= limit:
                return {"error": f"{target}: đã đủ {limit} lần tạo đầy đủ. Dùng 'Sửa đoạn hỏng' để vá từng đoạn."}
        est = round(sum(sp["units"] * sp["unit_price"] for sp in specs), 4)
        spent, reserved = money()
        if specs and spent + reserved + est > budget() + 1e-9:
            return {"error": f"Vượt trần: đã chi ~${spent:.2f} + đang chờ ~${reserved:.2f} + lần này ~${est:.2f} > trần ${budget():.2f}."}
        res = {"n": len(specs), "est": est, "items": [sp["label"] + f" · ~${sp['units'] * sp['unit_price']:.3f}" for sp in specs]}
        if dry or not specs:
            return res
        for sp in specs:
            extra = {"measure": True} if sp.get("measure") else None
            job = _new_job(sp["kind"], sp["target"], sp["provider"], sp["model"], sp["units"], sp["unit_price"], sp["label"], extra)
            if redo:
                STATE["picks"].pop(f"{sp['kind']}:{sp['target']}", None)
        save()
        log(f"Xếp hàng {len(specs)} việc ({stage}), ước tính ~${est:.3f}")
        return res


def deps_ready(job):
    k, t = job["kind"], job["target"]
    if k == "sheet" and not pick("portrait", t):
        return (False, None) if in_progress("portrait", t) else (False, f"Thiếu ảnh nhân vật {t}.")
    if k == "gen" and t == "S2b":
        s2a = pick("gen", "S2a")
        if not s2a:
            return (False, None) if in_progress("gen", "S2a") else (False, "Thiếu S2a.")
        if not s2a.get("last_frame"):
            return False, "S2a xong nhưng chưa có khung hình cuối (return_last_frame)."
    if k == "patch":
        if not pick("fix_img", t):
            return (False, None) if in_progress("fix_img", t) else (False, "Thiếu ảnh sửa đã duyệt.")
    return True, None


ASPECT_OF = {"portrait": "3:4", "sheet": "21:9", "env_wide": "9:16", "env_rev": "9:16", "prop": "1:1", "storyboard": "9:16"}


def chat_rewrite(text):
    ws = ws_client()
    st = S()
    content, usage = ws.chat(st["llm_write"], REWRITE_SYS, text, False)
    pt = usage.get("prompt_tokens") or int((len(REWRITE_SYS) + len(text)) / 3.5)
    ct = usage.get("completion_tokens") or int(len(content) / 3.5)
    cost = round(pt / 1e6 * st["llm_write_in"] + ct / 1e6 * st["llm_write_out"], 5)
    return content.strip(), cost


def build_edit_body(job):
    st = S()
    base = STATE["jobs"].get(job["base_take"])
    if not base:
        raise ApiError("Không còn bản gốc để sửa.")
    rewritten, rewrite_cost = chat_rewrite(job["chat_text"])
    refs = [url_of(base)] + [url_of(STATE["jobs"][aid]) for aid in (job.get("attachments") or []) if aid in STATE["jobs"]]
    body = {"prompt": rewritten, "images": refs, "aspect_ratio": ASPECT_OF.get(job["kind"], "9:16"),
            "resolution": job.get("resolution") or st["image_resolution"], "output_format": "jpeg"}
    chat_key = f"{job['kind']}:{job['target']}"
    with LOCK:
        STATE["chats"].setdefault(chat_key, []).append({"role": "assistant", "text": rewritten, "job": job["id"], "t": ts()})
    save()
    return body, rewritten, {"rewrite_cost": rewrite_cost}


def image_price_for(model, resolution):
    if "nano-banana" in model:
        return IMAGE_PRICE.get(resolution, 0.14)
    if "seedream" in model:
        return 0.027
    if "gpt-image" in model:
        return 0.19  # unverified — check WaveSpeed's own listing before the first real run (spec §14.3)
    return IMAGE_PRICE.get(resolution, 0.14)


def build_body(job):
    k, t = job["kind"], job["target"]
    st = S()
    if job.get("edit"):
        return build_edit_body(job)
    if k == "style":
        return None, None, None
    if k == "seq":
        return None, None, None
    if k == "portrait":
        c = STATE["chars"][t]
        if not c["components"]:
            raise ApiError(f"{c['name']}: chưa có ảnh thành phần nào.")
        refs = [url_of(cc) for cc in c["components"]]
        prompt = (f"Combine these reference components into ONE consistent character named {c['name']} "
                  f"({c['desc'] or 'a fictional adult'}) on a solid white background, photoreal, 3:4 portrait. "
                  "Use hair/eyes/face/body/costume from the matching tagged references. No text, no watermark.")
        return {"prompt": prompt, "images": refs, "aspect_ratio": "3:4", "resolution": st["image_resolution"],
                "output_format": "png"}, prompt, {"components": [cc["id"] for cc in c["components"]]}
    if k == "sheet":
        c = STATE["chars"][t]
        pj = pick("portrait", t)
        prompt = (f"Using the uploaded character image, build a 21:9 reference sheet on a solid white background: "
                  f"the right 70% shows 4 full-body views of {c['name']} (front, 3/4, side, back); the left 30% "
                  "shows 4 face views (front, 3/4 left, 3/4 right, profile). Keep the exact face and outfit. "
                  "No text, no watermark.")
        return {"prompt": prompt, "images": [url_of(pj)], "aspect_ratio": "21:9", "resolution": st["sheet_resolution"],
                "output_format": "png"}, prompt, {"portrait": pj["id"]}
    if k in ("env_wide", "env_rev"):
        e = STATE["envs"][t]
        angle = "an establishing wide shot" if k == "env_wide" else "the reverse camera angle of the same location"
        when = "night" if e.get("time") == "night" else "day"
        prompt = (f"Photoreal vertical 9:16 {angle}, {e.get('tag', 'EXT')} location, {when}time lighting: {e['text']}. "
                  "No text, no watermark, no people unless described.")
        return {"prompt": prompt, "aspect_ratio": "9:16", "resolution": st["image_resolution"],
                "output_format": "jpeg"}, prompt, {}
    if k == "prop":
        p = STATE["props"][t]
        desc = (" — " + p["desc"]) if p.get("desc") else ""
        prompt = f"Photoreal product-style still of a single prop: {p['name']}{desc}, solid white background, studio light. No text, no watermark."
        return {"prompt": prompt, "aspect_ratio": "1:1", "resolution": st["image_resolution"], "output_format": "jpeg"}, prompt, {}
    if k == "storyboard":
        sh = shot_by_id(t)
        refs = []
        for cname in sh["cast"]:
            c = _find_char(cname)
            sj = c and pick("sheet", c["id"])
            if sj:
                refs.append(url_of(sj))
        env = _find_env(sh["location"])
        ej = env and pick("env_wide", env["id"])
        if ej:
            refs.append(url_of(ej))
        prompt = (f"Photoreal vertical 9:16 film still, storyboard frame for shot {sh['id']}: {sh['desc']}. "
                  "Keep the exact face and identity of each character from their sheet reference; use the "
                  "environment reference for the location's look. No text, no watermark.")
        return {"prompt": prompt, "images": refs, "aspect_ratio": "9:16", "resolution": st["image_resolution"],
                "output_format": "jpeg"}, prompt, {}
    if k == "fix_img":
        f = STATE["fixes"][t]
        frame = pick("frame", t)
        prompt = f["prompt"] or "Fix this frame so it matches the character and scene exactly."
        return {"prompt": prompt, "images": [url_of(frame)], "aspect_ratio": "9:16", "resolution": st["image_resolution"],
                "output_format": "jpeg"}, prompt, {"frame": frame["id"]}
    if k == "prompt":
        return None, None, None
    if k == "review":
        return None, None, None
    if k == "gen":
        seq = STATE["seq"][SEQ_OF[t]]
        mapping = build_mapping(t)
        prompt = STATE["prompts"].get(t, {}).get("text") or ""
        body = {"prompt": prompt, "duration": DURATION[t], "resolution": st["resolution"], "ratio": "9:16",
                "generate_audio": True, "watermark": False, "return_last_frame": True,
                "omni_reference_task_type": "auto"}
        if mapping["images"]:
            body["reference_images"] = [img_url(e) for e in mapping["images"]]
        if mapping["videos"]:
            body["reference_videos"] = [img_url(e) for e in mapping["videos"]]
        if mapping["audios"]:
            body["reference_audios"] = [img_url(e) for e in mapping["audios"]]
        return body, prompt, {"mapping": mapping["text"]}
    if k == "patch":
        f = STATE["fixes"][t]
        gen = f["gen"]
        seq = STATE["seq"][SEQ_OF[gen]]
        mapping = build_mapping(gen)
        fix_img = pick("fix_img", t)
        dur = max(4, min(10, f["end"] - f["start"]))
        prompt = (f"{STATE['prompts'].get(gen, {}).get('text', '')}\n\nPatch only seconds {f['start']}-{f['end']} "
                  f"of this shot using the corrected reference frame as the extra image. Duration {dur}s. "
                  "Prohibited: " + PROHIBITED + ".")
        imgs = [img_url(e) for e in mapping["images"]] + [url_of(fix_img)]
        body = {"prompt": prompt, "duration": dur, "resolution": st["resolution"], "ratio": "9:16",
                "generate_audio": True, "watermark": False, "reference_images": imgs,
                "omni_reference_task_type": "edit"}
        if mapping["videos"]:
            body["reference_videos"] = [img_url(e) for e in mapping["videos"]]
        if mapping["audios"]:
            body["reference_audios"] = [img_url(e) for e in mapping["audios"]]
        return body, prompt, {"fix_img": fix_img["id"]}
    raise ApiError("Loại việc không rõ: " + k)


# ---------------------------------------------------------------- run / poll / scheduler
def finish_fail(jid, err, keep_cost=False):
    with LOCK:
        j = STATE["jobs"][jid]
        j["status"] = "failed"
        j["error"] = scrub(err)[:700]
        j["t_end"] = ts()
        if not keep_cost:
            j["cost"] = 0.0
    save()
    ledger(STATE["jobs"][jid], "lỗi: " + scrub(err)[:120], 0)
    log(f"LỖI {jid}: {err}")


def run_llm(jid):
    with LOCK:
        job = STATE["jobs"][jid]
        job["status"] = "running"
        st = dict(S())
    ws = ws_client()
    images = None
    if job["kind"] == "style":
        system, user = STYLE_SYS, "Screenplay:\n\n" + STATE["script"]
        model, jm, pin, pout = st["llm_write"], False, st["llm_write_in"], st["llm_write_out"]
    elif job["kind"] == "shots":
        given = STATE["shots_raw"].strip()
        user = (f"Pasted shot list:\n\n{given}" if given else f"Screenplay (no shot list pasted — invent one):\n\n{STATE['script']}")
        system = SHOTS_SYS
        model, jm, pin, pout = st["llm_write"], True, st["llm_write_in"], st["llm_write_out"]
    elif job["kind"] == "seq":
        system = SEQ_SYS
        user = "Shot list:\n\n" + json.dumps({"shots": STATE["shots"]}, ensure_ascii=False) + "\n\nReturn the JSON object now."
        model, jm, pin, pout = st["llm_write"], True, st["llm_write_in"], st["llm_write_out"]
    elif job["kind"] == "preprod":
        system = PREPROD_SYS
        user = (f"Screenplay:\n\n{STATE['script']}\n\nShot list:\n\n" + json.dumps({"shots": STATE["shots"]}, ensure_ascii=False))
        model, jm, pin, pout = st["llm_write"], True, st["llm_write_in"], st["llm_write_out"]
    elif job["kind"] == "critique":
        kind, tgt = job["target"].split(":", 1)
        j = pick(kind, tgt)
        if not j:
            raise ApiError("Chưa có ảnh để nhận xét.")
        images = [url_of(j)]
        system, user = CRITIQUE_SYS, "Critique this reference image."
        model, jm, pin, pout = st["llm_review"], False, st["llm_review_in"], st["llm_review_out"]
    elif job["kind"] == "prompt":
        gen = job["target"]
        seq = STATE["seq"][SEQ_OF[gen]]
        beats, lines = half_beats(seq, gen)
        mapping = build_mapping(gen)
        user = (f"Sequence tag: {seq['tag']}. Location: {seq['location']}. Duration: {DURATION[gen]}s.\n"
                f"Reference mapping (use these numbers only):\n{mapping['text']}\n\n"
                f"Beats: {json.dumps(beats, ensure_ascii=False)}\nDialogue: {json.dumps(lines, ensure_ascii=False)}\n"
                f"Raccord-in: {seq['raccord_in']}\nRaccord-out: {seq['raccord_out']}\n"
                "Write the prompt now.")
        system = PROMPT_SYS
        model, jm, pin, pout = st["llm_write"], False, st["llm_write_in"], st["llm_write_out"]
    else:  # review
        gen = job["target"]
        seq = STATE["seq"][SEQ_OF[gen]]
        beats, lines = half_beats(seq, gen)
        user = (f"Prompt:\n{STATE['prompts'].get(gen, {}).get('text', '')}\n\nSequence JSON subset:\n"
                f"{json.dumps({'beats': beats, 'lines': lines, 'raccord_in': seq['raccord_in'], 'raccord_out': seq['raccord_out']}, ensure_ascii=False)}")
        system = REVIEW_SYS
        model, jm, pin, pout = st["llm_review"], True, st["llm_review_in"], st["llm_review_out"]
    log(f"Gọi {model} ({STAGE_NAME[job['kind']]}) — có thể mất 20-120 giây…")
    try:
        content, usage = ws.chat(model, system, user, jm, images=images)
    except ApiError as e:
        if images and e.code in (400, 422):
            with LOCK:
                STATE["llm_vision_ok"] = False
            save()
            raise ApiError("LLM không nhận ảnh đính kèm — đã ẩn nút Nhận xét ảnh. " + str(e))
        raise
    pt = usage.get("prompt_tokens") or int((len(system) + len(user)) / 3.5)
    ct = usage.get("completion_tokens") or int(len(content) / 3.5)
    cost = round(pt / 1e6 * pin + ct / 1e6 * pout, 5)
    with LOCK:
        job.update(cost=cost, tokens={"in": pt, "out": ct}, result=content, t_end=ts(), status="done")
        try:
            if job["kind"] == "shots":
                STATE["shots"] = normalize_shots(parse_json(content))
                STATE["shots_v"] += 1
            elif job["kind"] == "seq":
                STATE["seq"] = normalize_seq(parse_json(content))
                STATE["seq_v"] += 1
            elif job["kind"] == "preprod":
                apply_preprod(parse_json(content))
            elif job["kind"] == "style":
                STATE["style"] = content
            elif job["kind"] == "prompt":
                STATE["prompts"].setdefault(job["target"], {})["text"] = content
                STATE["prompts"][job["target"]]["approved"] = False
            elif job["kind"] == "review":
                d = parse_json(content)
                STATE["prompts"].setdefault(job["target"], {})["review"] = d
            elif job["kind"] == "critique":
                chat_key = job["target"]
                STATE["chats"].setdefault(chat_key, []).append({"role": "critique", "text": content, "job": jid, "t": ts()})
        except Exception as e:
            job["status"] = "failed"
            job["error"] = f"Kết quả không đúng định dạng ({e}). Bấm tạo lại."
    save()
    ledger(job, "xong" if job["status"] == "done" else "lỗi định dạng", cost)
    log(f"{'Xong' if job['status'] == 'done' else 'Lỗi'} {jid} · {pt}+{ct} token · ${cost:.4f}")


def _dest_for(job, ext):
    k, t, v = job["kind"], job["target"], job["take"]
    if k == "portrait":
        return asset_dest(*make_filename("portrait", v, ext, name=STATE["chars"][t]["name"], label=STATE["chars"][t]["desc"] or "look"))
    if k == "sheet":
        return asset_dest(*make_filename("sheet", v, ext, name=STATE["chars"][t]["name"]))
    if k in ("env_wide", "env_rev"):
        e = STATE["envs"][t]
        return asset_dest(*make_filename(k, v, ext, name=e["name"], label=e["tag"]))
    if k == "prop":
        return asset_dest(*make_filename("prop", v, ext, name=STATE["props"][t]["name"]))
    if k == "storyboard":
        return asset_dest(*make_filename("storyboard", v, ext, name=t))
    if k == "fix_img":
        f = STATE["fixes"][t]
        return asset_dest(*make_filename("fix_img", v, ext, name=f"{f['gen']}_{f['start']}-{f['end']}s"))
    if k == "patch":
        f = STATE["fixes"][t]
        return asset_dest("02_Production/EP%02d" % ep_no(),
                           f"{proj_name()}_EP{ep_no():02d}_Video_{f['gen']}_patch_{f['start']}-{f['end']}s_v{v}{ext}")
    if k == "gen":
        return asset_dest("02_Production/EP%02d" % ep_no(), f"{proj_name()}_EP{ep_no():02d}_Video_{t}_v{v}{ext}")
    return OUT / "media" / k / f"{t}_t{v}{ext}"


def run_media(jid):
    with LOCK:
        job = STATE["jobs"][jid]
        resume = bool(job.get("pid"))
    if not resume:
        body, prompt, extra = build_body(job)  # may hit the network (uploads, chat rewrite) — do not hold LOCK
        with LOCK:
            if extra and extra.get("rewrite_cost"):
                job["est"] = round(job["est"] + extra["rewrite_cost"], 4)
            spent, _ = money()
            if spent + job["est"] > budget() + 1e-9:
                raise ApiError(f"Dừng: sẽ vượt trần ${budget():.2f}.")
            job.update(body=body, prompt=prompt, status="running")
            if extra:
                job.update(extra)
    else:
        with LOCK:
            job["status"] = "running"
    is_video = job["kind"] in VIDEO_KINDS
    client = atlas_client() if is_video else ws_client()
    measure = job.get("measure") and not resume
    before = mid = None
    if measure:
        before = read_balance(job["provider"])
    if not resume:
        pid = client.submit_video(job["model"], job["body"]) if is_video else client.submit_media(job["model"], job["body"])
        with LOCK:
            job.update(pid=pid, cost=job["est"], t_submit=time.time(), submitted=ts())
        save()
        ledger(job, "đã gửi", job["est"])
        log(f"Đã gửi {jid} (~${job['est']:.3f})")
        if measure:
            time.sleep(MEASURE_WAIT)
            mid = read_balance(job["provider"])
    else:
        log(f"Hỏi tiếp {jid} (đã gửi từ trước, không tính tiền lại)")
    limit = (45 if is_video else 15) * 60
    t0 = time.time()
    while True:
        time.sleep(POLL_SLEEP)
        try:
            status, val, last_frame = client.result(job["pid"])
        except ApiError as e:
            log(f"(chưa hỏi được {jid}: {e}; sẽ hỏi lại)")
            status, val, last_frame = "running", None, None
        if status == "running":
            if time.time() - t0 > limit:
                with LOCK:
                    job.update(status="stalled", error=f"Quá {limit // 60} phút chưa xong. Bấm 'Hỏi lại'.")
                save()
                return
            continue
        break
    if status == "failed":
        finish_fail(jid, f"Nhà cung cấp báo lỗi: {val}")
        return
    with LOCK:
        job["url"] = val
        if last_frame:
            job["last_frame"] = last_frame
    save()
    ext = providers.ext_for(val)
    dest = _dest_for(job, ext)
    try:
        providers.download(val, dest)
        with LOCK:
            job["file"] = str(dest.relative_to(HERE))
    except Exception as e:
        with LOCK:
            job["dl_error"] = scrub(str(e))
        log(f"Tải {jid} về máy thất bại ({e}); vẫn xem được qua link.")
    if measure:
        time.sleep(MEASURE_WAIT)
        after = read_balance(job["provider"])
        vals = [v for v in (mid, after) if v is not None]
        charge = round(before - min(vals), 4) if before is not None and vals else None
        per_unit = round(charge / job["units"], 4) if charge is not None and job["units"] else None
        with LOCK:
            job["measured"] = {"before": before, "mid": mid, "after": after, "charge": charge, "per_unit": per_unit}
        if charge is not None:
            ledger(job, f"đo giá thật: số dư giảm ${charge:.4f}", 0)
            log(f"Đo giá {job['model']}: ${charge:.4f} cho {job['units']} giây = ${per_unit}/giây")
        if per_unit is not None:
            apply_measured_price(job["target"], job["model"], per_unit)
    with LOCK:
        job.update(status="done", t_end=ts())
        STATE["picks"][f"{job['kind']}:{job['target']}"] = job["id"]
    save()
    ledger(job, "xong", 0)
    log(f"Xong {jid}")


def apply_measured_price(gen, model, per_unit):
    """Spec §4.3: use the real measured price from now on; if 2.5 measures above $0.16/s, warn and
    switch any not-yet-generated 2.5 sequence to 2.0 (owner can switch back with one click in Cài đặt)."""
    with LOCK:
        STATE["settings"]["price_" + gen] = per_unit
        if "seedance-2.5" in model and per_unit > PRICE_WARN_PER_S:
            log(f"CẢNH BÁO: {model} đo được ${per_unit}/s, cao hơn $0.16/s dự kiến.")
            for other in GENS:
                if other == gen or live_takes("gen", other):
                    continue
                if "seedance-2.5" in STATE["settings"].get("video_" + other, ""):
                    STATE["settings"]["video_" + other] = "bytedance/seedance-2.0/reference-to-video"
                    STATE["settings"]["price_" + other] = 0.09
                    log(f"Đã đổi {other} sang Seedance 2.0 (giá 2.5 đo được cao). Đổi lại ở Cài đặt nếu muốn.")
    save()


def run_job(jid):
    try:
        if STATE["jobs"][jid]["kind"] in LLM_KINDS:
            run_llm(jid)
        else:
            run_media(jid)
    except Exception as e:
        job = STATE["jobs"][jid]
        if job["status"] != "done":
            if job.get("pid"):
                with LOCK:
                    job.update(status="stalled", error=f"Lỗi khi chờ kết quả: {scrub(str(e))} — bấm 'Hỏi lại'.")
                save()
            else:
                finish_fail(jid, str(e))
        if not isinstance(e, ApiError):
            log(traceback.format_exc())
    finally:
        with LOCK:
            RUNNING.discard(jid)
            prov = STATE["jobs"][jid]["provider"]
            if SOLO.get(prov) == jid:
                SOLO.pop(prov, None)
            idle = not RUNNING and not any(j["status"] == "queued" for j in STATE["jobs"].values())
        if idle and STATE["jobs"][jid]["kind"] not in LLM_KINDS:
            refresh_balances()


def scheduler():
    while True:
        time.sleep(0.4)
        try:
            with LOCK:
                limit = max(1, int(S().get("parallel", 2)))
                queued = sorted((j for j in STATE["jobs"].values() if j["status"] == "queued"), key=lambda j: j["n"])
                for job in queued:
                    if len(RUNNING) >= limit:
                        break
                    prov = job["provider"]
                    holder = SOLO.get(prov)
                    if holder and holder != job["id"]:
                        continue
                    if job.get("measure"):
                        SOLO[prov] = job["id"]  # reserve the provider, then wait until it is idle
                        if any(STATE["jobs"][r]["provider"] == prov for r in RUNNING):
                            continue
                    ready, why = deps_ready(job)
                    if why:
                        job.update(status="failed", error=why, t_end=ts())
                        if SOLO.get(prov) == job["id"]:
                            SOLO.pop(prov, None)
                        save()
                        continue
                    if not ready:
                        continue
                    job["status"] = "starting"
                    RUNNING.add(job["id"])
                    threading.Thread(target=run_job, args=(job["id"],), daemon=True).start()
        except Exception:
            log(traceback.format_exc())


# ---------------------------------------------------------------- fixes (Sửa đoạn hỏng)
def new_fix(gen, start, end):
    if gen not in GENS:
        raise ValueError("gen không hợp lệ.")
    start, end = int(start), int(end)
    if end - start < 4:
        end = start + 4
    if end - start > 10:
        end = start + 10
    clip = pick("gen", gen)
    if not clip or not clip.get("file"):
        raise ValueError(f"{gen}: chưa có clip trên máy để cắt khung hình.")
    ff = shutil.which("ffmpeg")
    if not ff:
        raise ValueError("Máy chưa có ffmpeg — cài rồi thử lại (winget install Gyan.FFmpeg).")
    fid = f"fix_{len(STATE['fixes']) + 1}"
    frame_path = OUT / "media" / "frame" / f"{fid}.jpg"
    frame_path.parent.mkdir(parents=True, exist_ok=True)
    r = subprocess.run([ff, "-y", "-v", "error", "-ss", str(start), "-i", str(HERE / clip["file"]),
                        "-frames:v", "1", str(frame_path)], capture_output=True, text=True, errors="replace")
    if r.returncode != 0:
        raise ValueError("ffmpeg lỗi khi cắt khung hình: " + r.stderr[-300:])
    STATE["fixes"][fid] = {"id": fid, "gen": gen, "start": start, "end": end, "prompt": "", "created": ts()}
    save()
    register_local("frame", fid, frame_path)
    return STATE["fixes"][fid]


# ---------------------------------------------------------------- export (spec §5.7)
def do_export():
    proj, ep = proj_name(), ep_no()
    dst = HERE / "export" / f"EP{ep:02d}"
    dst.mkdir(parents=True, exist_ok=True)
    lines, files = [], []
    order = list(GENS)
    for gen in order:
        j = pick("gen", gen)
        if j and j.get("file"):
            name = Path(j["file"]).name
            shutil.copy2(HERE / j["file"], dst / name)
            lines.append(f"{gen}\t{name}\t0-{DURATION[gen]}s")
            files.append(name)
    for fid, f in STATE["fixes"].items():
        j = pick("patch", fid)
        if j and j.get("file"):
            name = Path(j["file"]).name
            shutil.copy2(HERE / j["file"], dst / name)
            lines.append(f"{f['gen']} patch\t{name}\t{f['start']}-{f['end']}s")
            files.append(name)
    (dst / "danh_sach.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    ff = shutil.which("ffmpeg")
    joined = None
    if ff:
        clips = [pick("gen", g) for g in order if pick("gen", g) and pick("gen", g).get("file")]
        if len(clips) == len(order):
            listfile = dst / "list.txt"
            listfile.write_text("".join(f"file '{Path(c['file']).name}'\n" for c in clips), encoding="utf-8")
            out = dst / f"{proj}_EP{ep:02d}_full.mp4"
            r = subprocess.run([ff, "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", str(listfile),
                                "-c", "copy", str(out)], capture_output=True, text=True, errors="replace", cwd=dst)
            if r.returncode == 0:
                joined = out.name
    with LOCK:
        STATE["export"] = {"status": "done", "dir": str(dst.relative_to(HERE)), "n": len(lines), "t": ts(),
                           "joined": joined, "files": files}
    save()
    log(f"Đã xuất {len(lines)} file vào {dst}")


# ---------------------------------------------------------------- cost / projection / public state
def cost_summary():
    spent, reserved = money()
    real = None
    for p in ("wavespeed", "atlas"):
        b = STATE["balance"].get(p, {})
        if b.get("start") is not None and b.get("now") is not None:
            real = (real or 0) + b["start"] - b["now"]
    series_spent = round(sum(j.get("cost", 0) for j in STATE["jobs"].values()
                              if j["kind"] in SERIES_KINDS and j["status"] in ("done", "stalled")), 4)
    episode_spent = round(spent - series_spent, 4)
    basis = real if real is not None else spent
    basis_episode = max(0.0, basis - series_spent)
    projection = round((basis_episode * N_EPISODES + series_spent) * VND_PER_USD)
    return {"spent": spent, "reserved": reserved, "real": real, "series_spent": series_spent,
            "episode_spent": episode_spent, "projection_vnd": projection, "target_vnd": TARGET_VND,
            "contract_vnd": CONTRACT_VND, "cap_usd": budget()}


def mapping_preview(gen):
    try:
        m = build_mapping(gen)
        return m["text"]
    except Exception as e:
        return "(chưa đủ dữ liệu để dựng tham chiếu: " + str(e) + ")"


def public_state():
    with LOCK:
        jobs = [{k: j.get(k) for k in ("id", "kind", "target", "take", "status", "model", "est", "cost", "error",
                                        "file", "url", "last_frame", "created", "label", "tokens", "units",
                                        "unit_price", "prompt", "dl_error", "result", "provider", "measure", "measured",
                                        "dur", "edit", "resolution")}
                for j in sorted(STATE["jobs"].values(), key=lambda j: j["n"])]
        todo = {}
        for stage in ("style", "shots", "seq", "preprod", "portrait", "sheet", "env_wide", "env_rev", "prop", "prompt", "review", "gen"):
            specs, err = specs_for(stage)
            todo[stage] = {"n": len(specs), "est": round(sum(sp["units"] * sp["unit_price"] for sp in specs), 4), "error": err}
        by_stage = {}
        for j in STATE["jobs"].values():
            b = by_stage.setdefault(j["kind"], {"done": 0, "failed": 0, "active": 0, "spent": 0.0})
            if j["status"] == "done":
                b["done"] += 1
            elif j["status"] in ("failed", "cancelled"):
                b["failed"] += 1
            else:
                b["active"] += 1
            if j["status"] in ("done", "stalled") or (j["status"] == "running" and j.get("pid")):
                b["spent"] = round(b["spent"] + j.get("cost", 0), 4)
        return {"token_ok": True, "project": STATE["project"], "script": STATE["script"], "style": STATE["style"],
                "shots_raw": STATE["shots_raw"], "shots": STATE["shots"], "shots_v": STATE["shots_v"],
                "chars": STATE["chars"], "envs": STATE["envs"], "props": STATE["props"], "voices": STATE["voices"],
                "video_refs": STATE["video_refs"], "seq": STATE["seq"], "seq_v": STATE["seq_v"],
                "prompts": STATE["prompts"], "qc": STATE["qc"], "fixes": STATE["fixes"], "settings": STATE["settings"],
                "chats": STATE["chats"], "llm_vision_ok": STATE.get("llm_vision_ok", True),
                "jobs": jobs, "picks": STATE["picks"], "todo": todo, "by_stage": by_stage, "budget": budget(),
                "keys": {p: bool(KEYS.get(k)) for p, k in KEY_OF.items()}, "money": {"spent": money()[0], "reserved": money()[1]},
                "balance": STATE["balance"], "cost": cost_summary(), "export": STATE["export"],
                "ffmpeg": bool(shutil.which("ffmpeg")), "gens": GENS, "duration": DURATION, "seq_of": SEQ_OF,
                "running": len(RUNNING), "stage_names": STAGE_NAME, "component_uses": COMPONENT_USES,
                "series_kinds": sorted(SERIES_KINDS), "mapping": {g: mapping_preview(g) for g in GENS}}
