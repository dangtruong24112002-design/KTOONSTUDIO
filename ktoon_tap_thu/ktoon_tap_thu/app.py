#!/usr/bin/env python3
"""KTOONSTUDIO · chạy thử 1 tập (bản thử, giao diện tạm).

Bấm đúp chay_windows.bat (Windows) hoặc chay_mac.command (Mac): app mở giao diện trên trình duyệt.
Các bước: 1 kịch bản (GPT) → 2 shot list (Gemini) → 3 ảnh nhân vật → 4 keyframe → 5 video (Seedance, Atlas)
→ 6 lồng tiếng + khẩu hình → 7 xem cả tập. Chi phí từng việc ghi vào output/so_chi.csv.

Key đọc từ keys.txt, không bao giờ gửi ra trình duyệt hay ghi vào file khác.
Chỉ dùng thư viện có sẵn của Python 3.8 trở lên.
"""
import csv
import json
import math
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
import webbrowser
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

HERE = Path(__file__).resolve().parent
OUT = HERE / "output"
MEDIA = OUT / "media"
STATE_FILE = OUT / "state.json"
LEDGER = OUT / "so_chi.csv"
LOG_FILE = OUT / "nhat_ky.txt"

# The KTOON_* variables exist only for the offline test harness.
WS = os.environ.get("KTOON_WS_BASE", "https://api.wavespeed.ai/api/v3")
WS_LLM = os.environ.get("KTOON_WS_LLM", "https://llm.wavespeed.ai/v1")
ATLAS = os.environ.get("KTOON_ATLAS_BASE", "https://api.atlascloud.ai/api/v1/model")
ATLAS_PUB = os.environ.get("KTOON_ATLAS_PUB", "https://api.atlascloud.ai/public/v1")
POLL_FAST = float(os.environ.get("KTOON_POLL_FAST", "3"))
POLL_SLOW = float(os.environ.get("KTOON_POLL_SLOW", "8"))
MEASURE_WAIT = float(os.environ.get("KTOON_MEASURE_WAIT", "6"))
NO_BROWSER = os.environ.get("KTOON_NO_BROWSER") == "1"
VND_PER_USD = 26170

KEY_OF = {"wavespeed": "WAVESPEED_API_KEY", "atlas": "ATLASCLOUD_API_KEY"}
PROVIDER_NAME = {"wavespeed": "WaveSpeed", "atlas": "Atlas Cloud"}
VOICES = ["Wise_Woman", "Friendly_Person", "Inspirational_girl", "Deep_Voice_Man", "Calm_Woman", "Casual_Guy",
          "Lively_Girl", "Patient_Man", "Young_Knight", "Determined_Man", "Lovely_Girl", "Decent_Boy",
          "Imposing_Manner", "Elegant_Man", "Abbess", "Sweet_Girl_2", "Exuberant_Girl"]
# Giá USD tham khảo (kiểm tra 28/9/2026), để ước tính và chặn trần, không phải hóa đơn.
VIDEO_PRESETS = {
    "bytedance/seedance-2.5/image-to-video": ["Seedance 2.5", 0.134],
    "bytedance/seedance-2.0/image-to-video": ["Seedance 2.0", 0.112],
    "bytedance/seedance-2.0-fast/image-to-video": ["Seedance 2.0 Fast", 0.0581],
    "bytedance/seedance-2.0-mini/image-to-video": ["Seedance 2.0 Mini", 0.0242],
}
DEFAULT_SETTINGS = {
    "script_model": "openai/gpt-5.5", "script_price_in": 5.0, "script_price_out": 30.0,
    "plan_model": "google/gemini-3.6-flash", "plan_price_in": 0.75, "plan_price_out": 3.8,
    "image_t2i": "bytedance/seedream-v5.0-flash", "image_edit": "bytedance/seedream-v5.0-flash/edit",
    "image_price": 0.027, "image_resolution": "1.5k",
    "video_A": "bytedance/seedance-2.5/image-to-video", "price_A": 0.134,
    "video_B": "bytedance/seedance-2.0-fast/image-to-video", "price_B": 0.0581,
    "video_C": "bytedance/seedance-2.0-mini/image-to-video", "price_C": 0.0242,
    "video_resolution": "720p",
    "voice_mode": "tts",
    "tts_model": "minimax/speech-2.8-turbo", "tts_price_per_1k_chars": 0.06,
    "lipsync_model": "wavespeed-ai/infinitetalk-fast/video-to-video", "lipsync_price_per_s": 0.015, "lipsync_min_s": 3,
    "max_takes": 3, "parallel": 4,
}
STAGE_NAME = {"script": "Kịch bản (GPT)", "plan": "Shot list (Gemini)", "char": "Ảnh nhân vật", "kf": "Keyframe",
              "vid": "Video", "tts": "Giọng đọc", "lip": "Khẩu hình"}

SAMPLE_PREMISE = """Series: The Billionaire Undercover — phim dọc 9:16, 60 tập x 90 giây, khán giả Mỹ, thoại tiếng Anh.

Tập 1: Ethan Cole (33 tuổi), tỷ phú bí mật vừa mua lại tòa nhà Hayes Tower, giả làm thợ bảo trì để tìm kẻ biển thủ trong công ty. Claire Hayes (29 tuổi), giám đốc tài chính sắc sảo, bắt gặp anh ở tầng 40 nơi thợ không được lên. Trưởng phòng Mark Dalton (40 tuổi) sỉ nhục Ethan trước mọi người và cố tình làm đổ cà phê lên áo anh. Claire lặng lẽ đưa khăn giấy cho Ethan, hai người nhìn nhau. Cuối tập, hội đồng quản trị chờ "chủ tịch mới" — Ethan bước vào phòng họp, bình thản: "Actually... I own this building."

Yêu cầu: hook trong 3 giây đầu, một cú twist giữa tập, cliffhanger cuối tập. Chỉ 3 nhân vật, 2 bối cảnh (hành lang tầng 40, phòng họp kính)."""

SCRIPT_SYS = """You are the head writer of a US vertical microdrama studio (ReelShort / DramaBox style).
Write ONE episode of about 90 seconds of screen time for a vertical 9:16, photoreal, AI-generated series.
Rules:
- All characters are fictional adults (21+). No real people, no real brands or logos.
- Hook in the first 3 seconds, one clear twist mid-episode, end on a cliffhanger.
- Dialogue in natural American English: short and punchy, at most 12 words per line, about 110 spoken words in total.
- Keep it cheap to produce: 2 to 4 characters, 1 to 3 locations.
- Write visual, filmable action. No voice-over narration, no inner thoughts.
Output plain text, no markdown fences, in this order:
TÓM TẮT (tiếng Việt): 3-5 câu tóm tắt tập bằng tiếng Việt.
CHARACTERS: one line each: Name (age): look, wardrobe, personality.
LOCATIONS: one line each.
SCREENPLAY: scene headings (INT./EXT.), action lines, and dialogue written as NAME: line."""

PLAN_SYS = """You turn a microdrama screenplay into a production shot list for AI image-to-video generation.
Return ONLY one JSON object with exactly this schema:
{"title": str,
 "characters": [{"id": "lowercase_id", "name": str, "look": str, "voice": str}],
 "locations": [{"id": "L1", "name": str, "block": str}],
 "shots": [{"tier": "A"|"B"|"C", "duration": int, "location": "L1", "cast": ["character id", ...],
            "speaker": "character id or empty string", "line": "English dialogue or empty string",
            "note_vi": str, "keyframe_prompt": str, "video_prompt": str}]}
Rules:
- 16 to 20 shots; total duration 85-95 seconds; each shot 4-8 seconds (tier A may be up to 10).
- tier A = hook, twist, cliffhanger (about 15 s in total); tier B = acting and dialogue (about 50 s); tier C = establishing shots, inserts, silent reactions (about 25 s).
- At most one speaker per shot. A line must fit its shot: at most 2.5 words per second of the shot, minus one second. Split long exchanges into more shots.
- cast = characters visible in the keyframe, at most 3, the speaker first.
- characters[].look = a photoreal vertical 9:16 portrait prompt of a fictional adult: age, face shape, skin ('retain true micro pores and skin texture'), eyes, brows, nose, lips, hair, wardrobe, expression, medium close-up, soft natural light; end with 'No text, no logo, no watermark.'
- characters[].voice = the best fit from: Wise_Woman, Friendly_Person, Inspirational_girl, Deep_Voice_Man, Calm_Woman, Casual_Guy, Lively_Girl, Patient_Man, Young_Knight, Determined_Man, Lovely_Girl, Decent_Boy, Imposing_Manner, Elegant_Man, Abbess, Sweet_Girl_2, Exuberant_Girl.
- locations[].block = one English sentence describing the set, light and palette; it is reused in every shot at that location.
- keyframe_prompt = a photoreal vertical 9:16 film still. Refer to cast members as 'the man in image 1', 'the woman in image 2', in the same order as cast, starting with 'Keep the exact face, hair and build of ...'. Put the literal token {location} where the set description goes. Describe pose, expression, framing, lens and light. End with 'No text, no watermark.' If cast is empty, just describe the scene.
- video_prompt = English, Seedance style: shot size and camera move, timed beats such as '[0-2s] ... [2-5s] ...', acting, SFX, with the literal token {location}; end with 'Strictly keep the faces from the first frame. No subtitles, no background music, no AI artifacts.' Never put the spoken line inside video_prompt.
- note_vi = a short Vietnamese note on the purpose of the shot."""


class ApiError(Exception):
    def __init__(self, msg, code=None):
        super().__init__(msg)
        self.code = code


LOCK = threading.RLock()
STATE = {}
KEYS = {}
TOKEN = secrets.token_urlsafe(18)
RUNNING = set()     # job ids with a live worker thread
SOLO = {}           # provider -> job id measuring the real price (no other job may run there meanwhile)
PORT = [8765]


# ---------------------------------------------------------------- basics
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


def budget():
    try:
        return float(KEYS.get("BUDGET_USD", "20"))
    except ValueError:
        return 20.0


def fresh_state():
    return {"v": 1, "created": ts(), "settings": dict(DEFAULT_SETTINGS), "premise": SAMPLE_PREMISE,
            "script": "", "plan": None, "plan_v": 0, "jobs": {}, "picks": {}, "seq": 0,
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
        os.replace(tmp, STATE_FILE)


def ledger(job, event, amount):
    new = not LEDGER.exists()
    try:
        with open(LEDGER, "a", newline="", encoding="utf-8-sig" if new else "utf-8") as f:
            w = csv.writer(f)
            if new:
                w.writerow(["thời gian", "việc", "model", "số lượng", "đơn giá USD", "USD", "sự kiện"])
            w.writerow([ts(), job["id"], job["model"], job.get("units"), job.get("unit_price"),
                        round(amount, 4), event])
    except OSError as e:
        log(f"Không ghi được so_chi.csv ({e}) — file đang mở trong Excel? Đóng Excel rồi thôi.")


def S():
    return STATE["settings"]


# ---------------------------------------------------------------- http
def http(method, url, key, body=None, timeout=120):
    """One API call. A POST that creates a paid job is retried only on HTTP 429 (request not processed)."""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    host = urlparse(url).netloc
    for attempt in range(4):
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", "Bearer " + key)
        req.add_header("User-Agent", "ktoonstudio-test/1.0")
        req.add_header("Accept", "application/json")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
            try:
                return json.loads(raw.decode("utf-8")) if raw else {}
            except ValueError:
                raise ApiError(f"{host} trả về dữ liệu không đọc được: {raw[:120]!r}")
        except urllib.error.HTTPError as e:
            msg = scrub(e.read().decode("utf-8", "replace")[:600])
            retry = e.code == 429 or (method == "GET" and e.code >= 500)
            if retry and attempt < 3:
                time.sleep(6 * (attempt + 1))
                continue
            if e.code in (401, 403):
                raise ApiError(f"{host} từ chối key (HTTP {e.code}). Kiểm tra key trong keys.txt. {msg[:200]}", e.code)
            if e.code == 402:
                raise ApiError(f"{host} báo hết tiền (HTTP 402). Nạp thêm rồi chạy lại.", e.code)
            raise ApiError(f"{host} báo lỗi HTTP {e.code}: {msg}", e.code)
        except (urllib.error.URLError, OSError) as e:
            if method == "GET" and attempt < 3:
                time.sleep(6 * (attempt + 1))
                continue
            raise ApiError(f"Không kết nối được {host}: {scrub(getattr(e, 'reason', e))}")
    raise ApiError(f"{host} không trả lời sau nhiều lần thử")


def download(url, dest):
    req = urllib.request.Request(url, headers={"User-Agent": "ktoonstudio-test/1.0"})
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".part")
    with urllib.request.urlopen(req, timeout=300) as r, open(tmp, "wb") as f:
        shutil.copyfileobj(r, f, 1 << 16)
    os.replace(tmp, dest)


def ext_for(url, kind):
    path = urlparse(url).path.lower()
    for e in (".jpg", ".jpeg", ".png", ".webp", ".mp4", ".mov", ".webm", ".mp3", ".wav", ".m4a", ".ogg", ".flac"):
        if path.endswith(e):
            return ".jpg" if e == ".jpeg" else e
    return {"char": ".jpg", "kf": ".jpg", "vid": ".mp4", "lip": ".mp4", "tts": ".mp3"}.get(kind, ".bin")


# ---------------------------------------------------------------- providers
def key_for(provider):
    k = KEYS.get(KEY_OF[provider], "")
    if not k:
        raise ApiError(f"Chưa có {KEY_OF[provider]} trong keys.txt.")
    return k


def submit(job):
    key = key_for(job["provider"])
    if job["provider"] == "wavespeed":
        r = http("POST", f"{WS}/{job['model']}", key, job["body"])
        d = r.get("data") or r
        pid = d.get("id")
    else:
        r = http("POST", f"{ATLAS}/generateVideo", key, job["body"])
        d = r.get("data") or r
        pid = d.get("id") or d.get("prediction_id")
    if not pid:
        raise ApiError("Nhà cung cấp không trả về mã việc: " + scrub(json.dumps(r, ensure_ascii=False)[:300]))
    return pid


def poll(job):
    key = key_for(job["provider"])
    if job["provider"] == "wavespeed":
        d = http("GET", f"{WS}/predictions/{job['pid']}/result", key)
    else:
        d = http("GET", f"{ATLAS}/prediction/{job['pid']}", key)
    d = d.get("data") or d
    st = str(d.get("status") or "").lower()
    if st in ("completed", "succeeded", "success"):
        outs = d.get("outputs") or []
        if not outs:
            return "failed", "Báo xong nhưng không có file."
        out = outs[0]
        if isinstance(out, dict):
            out = out.get("url") or out.get("uri") or ""
        return "done", out
    if st in ("failed", "error", "canceled", "cancelled"):
        return "failed", scrub(d.get("error") or st)
    return "running", None


def read_balance(provider):
    key = KEYS.get(KEY_OF[provider])
    if not key:
        return None
    try:
        if provider == "wavespeed":
            r = http("GET", f"{WS}/balance", key, timeout=30)
            return float((r.get("data") or {}).get("balance"))
        r = http("GET", f"{ATLAS_PUB}/balance", key, timeout=30)
        return float((r.get("available") or {}).get("value"))
    except Exception as e:  # balance is only informative
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


def chat(model, system, user, json_mode):
    key = key_for("wavespeed")
    body = {"model": model, "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    try:
        r = http("POST", f"{WS_LLM}/chat/completions", key, body, timeout=900)
    except ApiError as e:
        if json_mode and e.code in (400, 422):
            body.pop("response_format", None)
            r = http("POST", f"{WS_LLM}/chat/completions", key, body, timeout=900)
        else:
            raise
    choice = (r.get("choices") or [{}])[0]
    content = (choice.get("message") or {}).get("content")
    if isinstance(content, list):
        content = "".join(p.get("text", "") for p in content if isinstance(p, dict))
    if not content:
        raise ApiError("Model trả về rỗng" + (f" (finish_reason={choice.get('finish_reason')})" if choice.get("finish_reason") else ""))
    return content.strip(), r.get("usage") or {}


# ---------------------------------------------------------------- plan helpers
def slug(s):
    s = re.sub(r"[^a-z0-9]+", "_", str(s or "").lower()).strip("_")
    return s[:24] or "nv"


def normalize_plan(p):
    if not isinstance(p, dict):
        raise ValueError("Shot list phải là một JSON object.")
    chars, seen = [], set()
    for c in p.get("characters") or []:
        if not isinstance(c, dict):
            continue
        cid = slug(c.get("id") or c.get("name"))
        while cid in seen:
            cid += "_2"
        seen.add(cid)
        name = str(c.get("name") or cid).strip()
        look = str(c.get("look") or "").strip() or (
            f"Photoreal cinematic portrait, vertical 9:16, of a fictional adult named {name}, medium close-up, soft natural light. No text, no logo, no watermark.")
        voice = c.get("voice") if c.get("voice") in VOICES else "Friendly_Person"
        chars.append({"id": cid, "name": name, "look": look, "voice": voice})
    by_name = {}
    for c in chars:
        by_name[c["name"].lower()] = c["id"]
        by_name.setdefault(c["name"].split()[0].lower(), c["id"])

    def cid_of(x):
        x = str(x or "").strip()
        if not x:
            return ""
        if slug(x) in seen:
            return slug(x)
        return by_name.get(x.lower()) or by_name.get(x.split()[0].lower(), "")

    locs = []
    for i, l in enumerate(p.get("locations") or []):
        if not isinstance(l, dict):
            continue
        lid = str(l.get("id") or f"L{i + 1}").strip()
        locs.append({"id": lid, "name": str(l.get("name") or lid), "block": str(l.get("block") or "").strip()})
    loc_ids = [l["id"] for l in locs]
    shots = []
    for i, s in enumerate(p.get("shots") or []):
        if not isinstance(s, dict):
            continue
        tier = str(s.get("tier") or "B").strip().upper()[:1]
        tier = tier if tier in ("A", "B", "C") else "B"
        try:
            dur = int(round(float(s.get("duration") or 5)))
        except (TypeError, ValueError):
            dur = 5
        dur = max(4, min(15, dur))
        cast = []
        raw_cast = s.get("cast") or []
        if isinstance(raw_cast, str):
            raw_cast = [x for x in re.split(r"[,;]", raw_cast)]
        for x in raw_cast:
            y = cid_of(x)
            if y and y not in cast:
                cast.append(y)
        speaker = cid_of(s.get("speaker"))
        line = str(s.get("line") or "").strip() if speaker else ""
        if not line:
            speaker = ""
        if speaker:
            cast = [speaker] + [c for c in cast if c != speaker]
        cast = cast[:3]
        loc = str(s.get("location") or "").strip()
        if loc not in loc_ids:
            loc = loc_ids[0] if loc_ids else ""
        shots.append({"id": f"S{len(shots) + 1:02d}", "tier": tier, "duration": dur, "location": loc, "cast": cast,
                      "speaker": speaker, "line": line, "note_vi": str(s.get("note_vi") or s.get("note") or "").strip(),
                      "keyframe_prompt": str(s.get("keyframe_prompt") or "").strip(),
                      "video_prompt": str(s.get("video_prompt") or "").strip()})
    if not shots:
        raise ValueError("Shot list không có shot nào.")
    return {"title": str(p.get("title") or "").strip(), "characters": chars, "locations": locs, "shots": shots}


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


def plan():
    return STATE.get("plan") or {"characters": [], "locations": [], "shots": []}


def char_by_id(cid):
    for c in plan()["characters"]:
        if c["id"] == cid:
            return c
    return None


def shot_by_id(sid):
    for s in plan()["shots"]:
        if s["id"] == sid:
            return s
    return None


def loc_block(lid):
    for l in plan()["locations"]:
        if l["id"] == lid:
            return l["block"]
    return ""


def with_location(text, lid):
    loc = loc_block(lid)
    if "{location}" in text:
        return text.replace("{location}", loc)
    return text + (f" Setting: {loc}" if loc else "")


def kf_prompt(s):
    p = s["keyframe_prompt"] or f"Photoreal vertical 9:16 film still from a US microdrama. {s['note_vi']}"
    p = with_location(p, s["location"])
    if "watermark" not in p.lower():
        p += " No text, no watermark."
    return p.strip()


def video_prompt(s):
    p = with_location(s["video_prompt"] or "Photoreal vertical 9:16 microdrama shot, subtle natural motion.", s["location"])
    if s["line"] and s["speaker"]:
        c = char_by_id(s["speaker"])
        name = c["name"] if c else s["speaker"]
        if S().get("voice_mode") == "native":
            p += f' {name} says in clear, natural American English: "{s["line"]}"'
        else:
            p += f" {name} is speaking, natural mouth movement; ambient sound only, no audible speech."
    return p.strip()


def video_model(tier):
    m = S().get("video_" + tier) or DEFAULT_SETTINGS["video_" + tier]
    return m, float(S().get("price_" + tier) or DEFAULT_SETTINGS["price_" + tier])


def model_label(model):
    return VIDEO_PRESETS.get(model, [model.split("/")[-1]])[0]


# ---------------------------------------------------------------- jobs
def takes(kind, target):
    pv = STATE.get("plan_v", 0)
    return sorted((j for j in STATE["jobs"].values()
                   if j["kind"] == kind and j["target"] == target and j.get("pv", 0) == pv),
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


def money():
    spent = reserved = 0.0
    for j in STATE["jobs"].values():
        st = j["status"]
        if st in ("queued", "starting"):
            reserved += j["est"]
        elif st == "running":
            if j.get("pid"):
                spent += j.get("cost", 0)
            else:
                reserved += j["est"]
        elif st in ("done", "stalled"):
            spent += j.get("cost", 0)
    return round(spent, 4), round(reserved, 4)


def llm_est(price_in, price_out, prompt_chars, out_tokens):
    return prompt_chars / 3.5 / 1e6 * price_in + out_tokens / 1e6 * price_out


def specs_for(stage, target=None, redo=False):
    """What a run of this stage would create: (list of job specs, error)."""
    st = S()
    out = []
    if stage == "script":
        if not STATE["premise"].strip():
            return [], "Chưa có ý tưởng tập."
        est = llm_est(st["script_price_in"], st["script_price_out"], len(SCRIPT_SYS) + len(STATE["premise"]), 7000)
        return [dict(kind="script", target="ep", provider="wavespeed", model=st["script_model"], units=1,
                     unit_price=round(est, 4), label="Viết kịch bản")], None
    if stage == "plan":
        if not STATE["script"].strip():
            return [], "Chưa có kịch bản (bước 1)."
        est = llm_est(st["plan_price_in"], st["plan_price_out"], len(PLAN_SYS) + len(STATE["script"]), 9000)
        return [dict(kind="plan", target="ep", provider="wavespeed", model=st["plan_model"], units=1,
                     unit_price=round(est, 4), label="Tạo shot list")], None
    if not STATE.get("plan"):
        return [], "Chưa có shot list (bước 2)."
    pl = plan()
    if stage == "char":
        for c in pl["characters"]:
            if target and c["id"] != target:
                continue
            if not redo and live_takes("char", c["id"]):
                continue
            out.append(dict(kind="char", target=c["id"], provider="wavespeed", model=st["image_t2i"], units=1,
                            unit_price=st["image_price"], label=f"Ảnh {c['name']}"))
        return out, None
    if stage == "kf":
        for s in pl["shots"]:
            if target and s["id"] != target:
                continue
            if not redo and live_takes("kf", s["id"]):
                continue
            missing = [c for c in s["cast"] if not pick("char", c) and not in_progress("char", c)]
            if missing:
                names = ", ".join((char_by_id(c) or {"name": c})["name"] for c in missing)
                return [], f"Tạo ảnh nhân vật trước: {names} (bước 3)."
            model = st["image_edit"] if s["cast"] else st["image_t2i"]
            out.append(dict(kind="kf", target=s["id"], provider="wavespeed", model=model, units=1,
                            unit_price=st["image_price"], label=f"Keyframe {s['id']}"))
        return out, None
    if stage in ("vid", "probe"):
        seen_tiers = set()
        for s in pl["shots"]:
            if target and s["id"] != target:
                continue
            if stage == "probe":
                if s["tier"] in seen_tiers or live_takes("vid", s["id"]):
                    continue
            elif not redo and live_takes("vid", s["id"]):
                continue
            if not pick("kf", s["id"]) and not in_progress("kf", s["id"]):
                if stage == "probe":
                    continue
                return [], f"Shot {s['id']} chưa có keyframe (bước 4)."
            model, price = video_model(s["tier"])
            spec = dict(kind="vid", target=s["id"], provider="atlas", model=model, units=s["duration"],
                        unit_price=price, label=f"Video {s['id']} · hạng {s['tier']} · {model_label(model)} · {s['duration']}s")
            if stage == "probe":
                spec["measure"] = True
                spec["label"] += " · đo giá"
                seen_tiers.add(s["tier"])
            out.append(spec)
        if stage == "probe" and not out:
            return [], "Cần ít nhất một shot đã có keyframe mà chưa có video."
        return out, None
    if stage in ("voice", "tts", "lip"):
        if st.get("voice_mode") == "native":
            return [], "Đang dùng chế độ Seedance tự nói (Cài đặt), không cần bước này."
        for s in pl["shots"]:
            if not s["line"] or (target and s["id"] != target):
                continue
            c = char_by_id(s["speaker"]) or {"name": s["speaker"], "voice": "Friendly_Person"}
            want_tts = stage in ("voice", "tts") and (redo or not live_takes("tts", s["id"]))
            want_lip = (redo or not live_takes("lip", s["id"]) or want_tts)
            if want_lip and not pick("vid", s["id"]) and not in_progress("vid", s["id"]):
                return [], f"Shot {s['id']} chưa có video (bước 5)."
            if want_tts:
                out.append(dict(kind="tts", target=s["id"], provider="wavespeed", model=st["tts_model"],
                                units=len(s["line"]), unit_price=st["tts_price_per_1k_chars"] / 1000.0,
                                label=f"Giọng {c['name']} · {s['id']}"))
            if want_lip:
                secs = max(float(st["lipsync_min_s"]), math.ceil(s["duration"]))
                out.append(dict(kind="lip", target=s["id"], provider="wavespeed", model=st["lipsync_model"],
                                units=secs, unit_price=st["lipsync_price_per_s"], label=f"Khẩu hình {s['id']}"))
        return out, None
    return [], "Bước không hợp lệ."


def create_jobs(stage, target=None, redo=False, dry=False):
    with LOCK:
        specs, err = specs_for(stage, target, redo)
        if err:
            return {"error": err}
        for sp in specs:
            sp["est"] = round(sp["units"] * sp["unit_price"], 4)
            if not KEYS.get(KEY_OF[sp["provider"]]):
                return {"error": f"Chưa có {KEY_OF[sp['provider']]} trong keys.txt (Cài đặt → Đọc lại keys.txt sau khi dán key)."}
        if redo and target:
            limit = int(S().get("max_takes", 3)) if stage in ("vid", "lip", "tts") else 5
            for sp in specs:
                if len(live_takes(sp["kind"], sp["target"])) >= limit:
                    return {"error": f"{sp['label']}: đã đủ {limit} lần tạo (giới hạn làm lại)."}
        est = round(sum(sp["est"] for sp in specs), 4)
        spent, reserved = money()
        if specs and spent + reserved + est > budget() + 1e-9:
            return {"error": f"Vượt trần: đã chi ~${spent:.2f} + đang chờ ~${reserved:.2f} + lần này ~${est:.2f} > trần ${budget():.2f}. "
                             "Tăng BUDGET_USD trong keys.txt rồi bấm Cài đặt → Đọc lại keys.txt."}
        res = {"n": len(specs), "est": est, "items": [sp["label"] + f" · ~${sp['est']:.3f}" for sp in specs]}
        if dry or not specs:
            return res
        for sp in specs:
            STATE["seq"] += 1
            prev = [j["take"] for j in STATE["jobs"].values() if j["kind"] == sp["kind"] and j["target"] == sp["target"]]
            take = 1 + max(prev or [0])
            jid = f"{sp['kind']}:{sp['target']}:t{take}"
            job = dict(id=jid, seq=STATE["seq"], kind=sp["kind"], target=sp["target"], take=take,
                       provider=sp["provider"], model=sp["model"], units=sp["units"], unit_price=sp["unit_price"],
                       est=sp["est"], cost=0.0, status="queued", created=ts(), label=sp["label"],
                       pv=STATE.get("plan_v", 0) if sp["kind"] not in ("script", "plan") else 0)
            if sp.get("measure"):
                job["measure"] = True
            STATE["jobs"][jid] = job
            if redo:
                STATE["picks"].pop(f"{sp['kind']}:{sp['target']}", None)
        save()
        log(f"Xếp hàng {len(specs)} việc ({stage}), ước tính ~${est:.3f}")
        return res


def deps_ready(job):
    """-> (ready, fail_reason)"""
    k, t = job["kind"], job["target"]
    need = []
    if k == "kf":
        s = shot_by_id(t)
        if not s:
            return False, "Shot không còn trong shot list."
        need = [("char", c) for c in s["cast"]]
    elif k == "vid":
        need = [("kf", t)]
    elif k == "lip":
        need = [("vid", t), ("tts", t)]
    for kind, target in need:
        if in_progress(kind, target):      # a newer take is on its way: wait for it
            return False, None
        if pick(kind, target):
            continue
        return False, f"Thiếu đầu vào: {STAGE_NAME[kind]} {target} chưa có."
    return True, None


def build_body(job):
    k, t = job["kind"], job["target"]
    st = S()
    inputs = {}
    if k == "char":
        c = char_by_id(t)
        if not c:
            raise ApiError("Nhân vật không còn trong shot list.")
        prompt = c["look"]
        body = {"prompt": prompt, "aspect_ratio": "9:16", "resolution": st["image_resolution"], "output_format": "jpeg"}
    elif k == "kf":
        s = shot_by_id(t)
        prompt = kf_prompt(s)
        body = {"prompt": prompt, "aspect_ratio": "9:16", "resolution": st["image_resolution"], "output_format": "jpeg"}
        if s["cast"]:
            refs = [pick("char", c) for c in s["cast"]]
            body["images"] = [r["url"] for r in refs]
            inputs["char"] = [r["id"] for r in refs]
    elif k == "vid":
        s = shot_by_id(t)
        kf = pick("kf", t)
        prompt = video_prompt(s)
        body = {"model": job["model"], "prompt": prompt, "image": kf["url"], "duration": int(s["duration"]),
                "resolution": st["video_resolution"], "ratio": "adaptive", "generate_audio": True, "watermark": False}
        inputs["kf"] = kf["id"]
    elif k == "tts":
        s = shot_by_id(t)
        c = char_by_id(s["speaker"]) or {"voice": "Friendly_Person"}
        prompt = s["line"]
        body = {"text": s["line"], "voice_id": c["voice"], "speed": 1, "english_normalization": True}
    elif k == "lip":
        s = shot_by_id(t)
        c = char_by_id(s["speaker"]) or {"name": "The speaker"}
        v, a = pick("vid", t), pick("tts", t)
        prompt = f"{c['name']} speaks naturally; keep identity, lighting and camera unchanged."
        body = {"video": v["url"], "audio": a["url"], "prompt": prompt}
        inputs["vid"], inputs["tts"] = v["id"], a["id"]
    else:
        raise ApiError("Loại việc không rõ: " + k)
    return body, prompt, inputs


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
        premise, script = STATE["premise"], STATE["script"]
    if job["kind"] == "script":
        system, user, jm = SCRIPT_SYS, "Episode brief (may be in Vietnamese; write the episode as instructed):\n\n" + premise, False
        pin, pout = st["script_price_in"], st["script_price_out"]
    else:
        system, user, jm = PLAN_SYS, "Screenplay:\n\n" + script + "\n\nReturn the JSON object now.", True
        pin, pout = st["plan_price_in"], st["plan_price_out"]
    log(f"Gọi {job['model']} ({STAGE_NAME[job['kind']]}) — thường mất 20-120 giây…")
    content, usage = chat(job["model"], system, user, jm)
    pt = usage.get("prompt_tokens") or int((len(system) + len(user)) / 3.5)
    ct = usage.get("completion_tokens") or int(len(content) / 3.5)
    cost = round(pt / 1e6 * pin + ct / 1e6 * pout, 5)
    with LOCK:
        job.update(cost=cost, tokens={"in": pt, "out": ct, "exact": bool(usage)}, result=content, t_end=ts())
        if job["kind"] == "script":
            STATE["script"] = content
            job["status"] = "done"
        else:
            try:
                STATE["plan"] = normalize_plan(parse_json(content))
                STATE["plan_v"] = STATE.get("plan_v", 0) + 1
                job["status"] = "done"
            except Exception as e:
                job["status"] = "failed"
                job["error"] = f"Shot list trả về không đúng định dạng ({e}). Bấm tạo lại."
    save()
    ledger(job, "xong" if job["status"] == "done" else "lỗi định dạng", cost)
    log(f"{'Xong' if job['status'] == 'done' else 'Lỗi'} {jid} · {pt}+{ct} token · ${cost:.4f}")


def run_media(jid):
    with LOCK:
        job = STATE["jobs"][jid]
        resume = bool(job.get("pid"))
        if not resume:
            body, prompt, inputs = build_body(job)
            spent, _ = money()
            if spent + job["est"] > budget() + 1e-9:
                raise ApiError(f"Dừng: sẽ vượt trần ${budget():.2f}.")
            job.update(body=body, prompt=prompt, inputs=inputs)
        job["status"] = "running"
    measure = job.get("measure") and not resume
    before = mid = None
    if measure:
        before = read_balance(job["provider"])
    if not resume:
        pid = submit(job)
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
    slow = job["kind"] in ("vid", "lip")
    limit = (45 if slow else 15) * 60
    t0 = time.time()
    while True:
        time.sleep(POLL_SLOW if slow else POLL_FAST)
        try:
            status, val = poll(job)
        except ApiError as e:
            log(f"(chưa hỏi được {jid}: {e}; sẽ hỏi lại)")
            status, val = "running", None
        if status == "running":
            if time.time() - t0 > limit:
                with LOCK:
                    job.update(status="stalled", error=f"Quá {limit // 60} phút chưa xong. Bấm 'Hỏi lại' (không bị tính tiền lại).")
                save()
                log(f"{jid} quá giờ, tạm dừng hỏi.")
                return
            continue
        break
    if status == "failed":
        finish_fail(jid, f"Nhà cung cấp báo lỗi: {val}")
        return
    with LOCK:
        job["url"] = val
    save()
    dest = MEDIA / job["kind"] / f"{job['target']}_t{job['take']}{ext_for(val, job['kind'])}"
    try:
        download(val, dest)
        with LOCK:
            job["file"] = dest.relative_to(OUT).as_posix()
    except Exception as e:  # keep the URL; the browser can still show it
        with LOCK:
            job["dl_error"] = scrub(e)
        log(f"Tải {jid} về máy thất bại ({e}); vẫn xem được qua link.")
    if measure:
        time.sleep(MEASURE_WAIT)
        after = read_balance(job["provider"])
        vals = [v for v in (mid, after) if v is not None]
        charge = round(before - min(vals), 4) if before is not None and vals else None
        with LOCK:
            job["measured"] = {"before": before, "mid": mid, "after": after, "charge": charge,
                               "per_unit": round(charge / job["units"], 4) if charge is not None and job["units"] else None}
        if charge is not None:
            ledger(job, f"đo giá thật: số dư giảm ${charge:.4f}", 0)
            log(f"Đo giá {job['model']}: ${charge:.4f} cho {job['units']} giây = ${charge / job['units']:.4f}/giây")
    with LOCK:
        job.update(status="done", t_end=ts())
    save()
    ledger(job, "xong", 0)
    log(f"Xong {jid}")


def run_job(jid):
    try:
        if STATE["jobs"][jid]["kind"] in ("script", "plan"):
            run_llm(jid)
        else:
            run_media(jid)
    except Exception as e:
        job = STATE["jobs"][jid]
        if job["status"] != "done":
            if job.get("pid"):   # already sent (and paid): keep it and let the user ask again
                with LOCK:
                    job.update(status="stalled", error=f"Lỗi khi chờ kết quả: {scrub(e)} — bấm 'Hỏi lại'.")
                save()
                log(f"{jid} tạm dừng: {e}")
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
        if idle and STATE["jobs"][jid]["kind"] not in ("script", "plan"):
            refresh_balances()


def scheduler():
    while True:
        time.sleep(0.4)
        try:
            with LOCK:
                limit = max(1, int(S().get("parallel", 4)))
                queued = sorted((j for j in STATE["jobs"].values() if j["status"] == "queued"), key=lambda j: j["seq"])
                for job in queued:
                    if len(RUNNING) >= limit:
                        break
                    prov = job["provider"]
                    holder = SOLO.get(prov)
                    if holder and holder != job["id"]:
                        continue
                    if job.get("measure"):
                        SOLO[prov] = job["id"]   # reserve the provider, then wait until it is idle
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


# ---------------------------------------------------------------- export (optional, needs ffmpeg)
def final_clips():
    clips = []
    for s in plan()["shots"]:
        lip = pick("lip", s["id"]) if (s["line"] and S().get("voice_mode") != "native") else None
        vid = pick("vid", s["id"])
        j = lip or vid
        clips.append({"shot": s["id"], "tier": s["tier"], "duration": s["duration"], "job": j["id"] if j else None,
                      "file": j.get("file") if j else None, "url": j.get("url") if j else None,
                      "src": ("lip" if lip else "vid") if j else None, "line": s["line"]})
    return clips


def do_export():
    ff = shutil.which("ffmpeg")
    try:
        with LOCK:
            clips = [c for c in final_clips() if c["file"]]
        if not ff:
            raise RuntimeError("Máy chưa có ffmpeg.")
        if not clips:
            raise RuntimeError("Chưa có clip nào trên máy.")
        tmp = OUT / "xuat_tam"
        tmp.mkdir(exist_ok=True)
        names = []
        for i, c in enumerate(clips):
            src = OUT / c["file"]
            info = subprocess.run([ff, "-hide_banner", "-i", str(src)], capture_output=True, text=True, errors="replace")
            has_audio = "Audio:" in info.stderr
            dst = tmp / f"{i:02d}.mp4"
            cmd = [ff, "-y", "-v", "error", "-i", str(src)]
            if not has_audio:
                cmd += ["-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo"]
            cmd += ["-vf", "scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p",
                    "-map", "0:v:0", "-map", "0:a:0" if has_audio else "1:a:0",
                    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-b:a", "160k",
                    "-ar", "44100", "-ac", "2", "-shortest", str(dst)]
            r = subprocess.run(cmd, capture_output=True, text=True, errors="replace")
            if r.returncode != 0:
                raise RuntimeError(f"ffmpeg lỗi ở {c['shot']}: {r.stderr[-300:]}")
            names.append(dst.name)
        (tmp / "list.txt").write_text("".join(f"file '{n}'\n" for n in names), encoding="utf-8")
        out = OUT / f"tap_thu_{datetime.now().strftime('%Y%m%d_%H%M')}.mp4"
        r = subprocess.run([ff, "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", str(tmp / "list.txt"),
                            "-c", "copy", str(out)], capture_output=True, text=True, errors="replace")
        if r.returncode != 0:
            raise RuntimeError("ffmpeg lỗi khi ghép: " + r.stderr[-300:])
        with LOCK:
            STATE["export"] = {"status": "done", "file": out.name, "t": ts(), "n": len(names)}
        log(f"Đã xuất {out}")
    except Exception as e:
        with LOCK:
            STATE["export"] = {"status": "failed", "error": str(e), "t": ts()}
        log(f"Xuất MP4 lỗi: {e}")
    save()


# ---------------------------------------------------------------- state for the UI
def public_state():
    with LOCK:
        pv = STATE.get("plan_v", 0)
        jobs = []
        for j in sorted(STATE["jobs"].values(), key=lambda j: j["seq"]):
            if j["kind"] not in ("script", "plan") and j.get("pv", 0) != pv:
                continue
            jobs.append({k: j.get(k) for k in ("id", "kind", "target", "take", "status", "model", "est", "cost", "error",
                                                "file", "url", "measured", "inputs", "created", "label", "tokens",
                                                "units", "unit_price", "prompt", "dl_error", "result")})
        picks = {}
        if STATE.get("plan"):
            for c in plan()["characters"]:
                j = pick("char", c["id"])
                if j:
                    picks["char:" + c["id"]] = j["id"]
            for s in plan()["shots"]:
                for k in ("kf", "vid", "tts", "lip"):
                    j = pick(k, s["id"])
                    if j:
                        picks[f"{k}:{s['id']}"] = j["id"]
        todo = {}
        for stage in ("script", "plan", "char", "kf", "vid", "probe", "voice"):
            specs, err = specs_for(stage)
            todo[stage] = {"n": len(specs), "est": round(sum(sp["units"] * sp["unit_price"] for sp in specs), 4), "error": err}
        spent, reserved = money()
        by_stage = {}
        for j in STATE["jobs"].values():
            b = by_stage.setdefault(j["kind"], {"done": 0, "failed": 0, "active": 0, "spent": 0.0, "units": 0})
            if j["status"] == "done":
                b["done"] += 1
                b["units"] += j.get("units") or 0
            elif j["status"] in ("failed", "cancelled"):
                b["failed"] += 1
            else:
                b["active"] += 1
            if j["status"] in ("done", "stalled") or (j["status"] == "running" and j.get("pid")):
                b["spent"] = round(b["spent"] + j.get("cost", 0), 4)
        return {
            "token_ok": True, "settings": STATE["settings"], "budget": budget(),
            "keys": {p: bool(KEYS.get(k)) for p, k in KEY_OF.items()},
            "premise": STATE["premise"], "script": STATE["script"], "plan": STATE.get("plan"), "plan_v": pv,
            "jobs": jobs, "picks": picks, "explicit_picks": STATE["picks"], "todo": todo,
            "money": {"spent": spent, "reserved": reserved}, "by_stage": by_stage,
            "balance": STATE.get("balance", {}), "final": final_clips() if STATE.get("plan") else [],
            "export": STATE.get("export", {}), "ffmpeg": bool(shutil.which("ffmpeg")),
            "voices": VOICES, "presets": VIDEO_PRESETS, "vnd": VND_PER_USD, "running": len(RUNNING),
            "stage_names": STAGE_NAME,
        }


def archive_episode():
    with LOCK:
        if RUNNING or any(j["status"] == "queued" for j in STATE["jobs"].values()):
            return {"error": "Đang có việc chạy. Chờ xong rồi hãy bắt đầu tập mới."}
        dst = OUT / ("luu_" + datetime.now().strftime("%Y%m%d_%H%M%S"))
        dst.mkdir(parents=True)
        try:
            for name in ("state.json", "so_chi.csv", "media", "xuat_tam"):
                p = OUT / name
                if p.exists():
                    shutil.move(str(p), str(dst / name))
        except OSError as e:
            return {"error": f"Không cất được tập cũ ({e}). Đóng các file đang mở trong thư mục output rồi thử lại."}
        keep = {k: STATE["settings"][k] for k in STATE["settings"]}
        bal = STATE.get("balance", {})
        STATE.clear()
        STATE.update(fresh_state())
        STATE["settings"] = keep
        STATE["balance"] = bal
        MEDIA.mkdir(parents=True, exist_ok=True)
    refresh_balances(reset_start=True)
    log(f"Đã cất tập cũ vào {dst.name}, bắt đầu tập mới.")
    return {"ok": True, "archived": dst.name}


# ---------------------------------------------------------------- web server
CTYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
          ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".mp4": "video/mp4", ".mov": "video/quicktime",
          ".webm": "video/webm", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".ogg": "audio/ogg",
          ".flac": "audio/flac", ".csv": "text/csv; charset=utf-8", ".txt": "text/plain; charset=utf-8",
          ".json": "application/json; charset=utf-8"}


class QuietServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        if not isinstance(sys.exc_info()[1], (ConnectionError, TimeoutError)):
            super().handle_error(request, client_address)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _host_ok(self):
        return self.headers.get("Host", "") in (f"127.0.0.1:{PORT[0]}", f"localhost:{PORT[0]}")

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _file(self, path):
        size = path.stat().st_size
        ctype = CTYPES.get(path.suffix.lower(), "application/octet-stream")
        start, end = 0, size - 1
        rng = self.headers.get("Range", "")
        if rng.startswith("bytes=") and size:
            a, _, b = rng[6:].split(",")[0].partition("-")
            try:
                if a.strip():
                    start = int(a)
                    end = int(b) if b.strip() else size - 1
                else:
                    start = max(0, size - int(b))
            except ValueError:
                start, end = 0, size - 1
            end = min(end, size - 1)
            if start > end:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            self.send_response(200)
        length = max(0, end - start + 1)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        with open(path, "rb") as f:
            f.seek(start)
            left = length
            while left > 0:
                chunk = f.read(min(1 << 16, left))
                if not chunk:
                    break
                self.wfile.write(chunk)
                left -= len(chunk)

    def do_GET(self):
        if not self._host_ok():
            return self._send(403, {"error": "host"})
        path = unquote(urlparse(self.path).path)
        try:
            if path in ("/", "/index.html"):
                page = (HERE / "ui.html").read_text(encoding="utf-8").replace("__KTOON_TOKEN__", TOKEN)
                return self._send(200, page, "text/html; charset=utf-8")
            if path == "/api/state":
                if self.headers.get("X-Ktoon-Token") != TOKEN:
                    return self._send(403, {"error": "token"})
                return self._send(200, public_state())
            if path.startswith("/files/"):
                target = (OUT / path[len("/files/"):]).resolve()
                if OUT.resolve() not in target.parents or not target.is_file():
                    return self._send(404, {"error": "không có file"})
                return self._file(target)
            return self._send(404, {"error": "không có"})
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def do_POST(self):
        if not self._host_ok() or self.headers.get("X-Ktoon-Token") != TOKEN:
            return self._send(403, {"error": "Phiên không hợp lệ — tải lại trang."})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            data = json.loads(self.rfile.read(n).decode("utf-8") or "{}") if n else {}
        except ValueError:
            return self._send(400, {"error": "Dữ liệu gửi lên không đọc được."})
        try:
            return self._send(200, self.route(urlparse(self.path).path, data))
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except Exception as e:
            log(traceback.format_exc())
            return self._send(200, {"error": scrub(str(e))})

    def route(self, path, d):
        if path == "/api/run":
            return create_jobs(d.get("stage"), d.get("target") or None, bool(d.get("redo")), bool(d.get("dry")))
        if path == "/api/premise":
            with LOCK:
                STATE["premise"] = str(d.get("text") or "")
            save()
            return {"ok": True}
        if path == "/api/script":
            with LOCK:
                STATE["script"] = str(d.get("text") or "")
            save()
            return {"ok": True}
        if path == "/api/use_result":
            with LOCK:
                j = STATE["jobs"].get(d.get("job"))
                if not j or j["kind"] != "script" or not j.get("result"):
                    return {"error": "Không tìm thấy bản kịch bản này."}
                STATE["script"] = j["result"]
            save()
            return {"ok": True}
        if path == "/api/plan":
            with LOCK:
                old = STATE.get("plan")
                new = normalize_plan(d.get("plan"))
                if old and len(new["shots"]) != len(old["shots"]):
                    return {"error": "Không đổi được số shot ở đây. Muốn đổi số shot thì tạo lại shot list."}
                if not old:
                    STATE["plan_v"] = STATE.get("plan_v", 0) + 1
                STATE["plan"] = new
            save()
            return {"ok": True}
        if path == "/api/pick":
            with LOCK:
                j = STATE["jobs"].get(d.get("job"))
                if not j or j["status"] != "done":
                    return {"error": "Bản này chưa xong."}
                STATE["picks"][f"{j['kind']}:{j['target']}"] = j["id"]
            save()
            return {"ok": True}
        if path == "/api/settings":
            new = d.get("settings") or {}
            with LOCK:
                for k, v in new.items():
                    if k not in DEFAULT_SETTINGS:
                        continue
                    if isinstance(DEFAULT_SETTINGS[k], (int, float)) and not isinstance(DEFAULT_SETTINGS[k], bool):
                        try:
                            v = float(v)
                        except (TypeError, ValueError):
                            return {"error": f"{k} phải là số."}
                        if isinstance(DEFAULT_SETTINGS[k], int):
                            v = int(v)
                    elif not isinstance(v, str) or not v.strip():
                        return {"error": f"{k} không hợp lệ."}
                    STATE["settings"][k] = v.strip() if isinstance(v, str) else v
                if STATE["settings"]["voice_mode"] not in ("tts", "native"):
                    STATE["settings"]["voice_mode"] = "tts"
            save()
            return {"ok": True}
        if path == "/api/reload_keys":
            KEYS.clear()
            KEYS.update(load_keys())
            threading.Thread(target=refresh_balances, daemon=True).start()
            return {"ok": True, "keys": {p: bool(KEYS.get(k)) for p, k in KEY_OF.items()}, "budget": budget()}
        if path == "/api/balance":
            refresh_balances(reset_start=bool(d.get("reset_start")))
            return {"ok": True}
        if path == "/api/recheck":
            with LOCK:
                j = STATE["jobs"].get(d.get("job"))
                if not j or j["status"] != "stalled" or not j.get("pid"):
                    return {"error": "Việc này không cần hỏi lại."}
                j["status"] = "starting"
                RUNNING.add(j["id"])
            threading.Thread(target=run_job, args=(j["id"],), daemon=True).start()
            return {"ok": True}
        if path == "/api/cancel":
            with LOCK:
                n = 0
                for j in STATE["jobs"].values():
                    if j["status"] == "queued":
                        j.update(status="cancelled", error="Đã huỷ trước khi gửi — không tốn tiền.")
                        n += 1
                        if SOLO.get(j["provider"]) == j["id"]:
                            SOLO.pop(j["provider"], None)
            save()
            return {"ok": True, "n": n}
        if path == "/api/export":
            with LOCK:
                if STATE.get("export", {}).get("status") == "running":
                    return {"error": "Đang xuất."}
                STATE["export"] = {"status": "running", "t": ts()}
            threading.Thread(target=do_export, daemon=True).start()
            return {"ok": True}
        if path == "/api/new_episode":
            return archive_episode()
        return {"error": "Không rõ yêu cầu."}


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")
    OUT.mkdir(exist_ok=True)
    MEDIA.mkdir(exist_ok=True)
    KEYS.update(load_keys())
    STATE.update(load_state())
    resume = []
    for j in STATE["jobs"].values():
        if j["status"] in ("queued", "starting"):
            j.update(status="cancelled", error="App tắt trước khi gửi — không tốn tiền. Bấm chạy lại nếu cần.")
        elif j["status"] == "running" and not j.get("pid"):
            if j["kind"] in ("script", "plan"):
                j.update(status="failed", error="App tắt khi đang chờ model trả lời. Bấm chạy lại.")
            else:
                j.update(status="failed", cost=j.get("cost", 0),
                         error="App tắt đúng lúc đang gửi — có thể đã bị tính tiền, kiểm tra trong console nhà cung cấp.")
        elif j["status"] in ("running", "stalled") and j.get("pid"):
            j["status"] = "starting"
            resume.append(j["id"])
    save()
    srv = None
    for port in range(int(os.environ.get("KTOON_PORT", "8765")), 8800):
        try:
            srv = QuietServer(("127.0.0.1", port), Handler)
            PORT[0] = port
            break
        except OSError:
            continue
    if not srv:
        print("Không mở được cổng mạng nội bộ 8765-8799.")
        sys.exit(1)
    for jid in resume:
        RUNNING.add(jid)
        threading.Thread(target=run_job, args=(jid,), daemon=True).start()
    threading.Thread(target=scheduler, daemon=True).start()
    threading.Thread(target=refresh_balances, daemon=True).start()
    url = f"http://127.0.0.1:{PORT[0]}/"
    have = ", ".join(PROVIDER_NAME[p] for p, k in KEY_OF.items() if KEYS.get(k)) or "chưa có key nào"
    log(f"KTOON chạy thử 1 tập · key: {have} · trần ${budget():.2f}")
    log(f"Giao diện: {url}   (giữ cửa sổ này mở; đóng cửa sổ là tắt app, việc đang chạy sẽ tiếp tục lần sau)")
    if not NO_BROWSER:
        try:
            webbrowser.open(url)
        except Exception:
            pass
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        log("Đã tắt app.")


if __name__ == "__main__":
    main()
