"""tap1 — bản tối giản (yêu cầu #8): 1 trang, 3 bước, dự án "The Alpha", đúng 1 tập (EP01).
Không có HTTP server ở đây, xem app.py. Không đụng tới tap_thu_v2/ — chỉ tái dùng lại cùng cách gọi
API (WaveSpeed LLM + Seedream, Atlas Seedance), đọc key, sổ chi (so_chi.csv) và resume (khớp
tap_thu_v2/pipeline.py, rút gọn cho vừa 3 bước này, không có gì khác).

Bước 1: hồ sơ nhân vật (chữ) -> GPT viết prompt ảnh -> Seedream text-to-image (không ảnh ref).
Bước 2: shot list (giữ nguyên văn) -> GPT chia batch (<=30s, kiểm tra thoại 2.3 từ/giây, không cắt
        ngang thoại) -> GPT viết 1 prompt video/batch, tự trích @ImageN từ nhân vật đã duyệt.
Bước 3: Seedance reference-to-video mỗi batch (2.5 mặc định hoặc 2.0), tối đa 2 lần/batch.
"""
import json
import re
import threading
import time
import traceback
from datetime import datetime
from pathlib import Path

import providers
from providers import ApiError

HERE = Path(__file__).resolve().parent
OUT = HERE / "output"
STATE_FILE = OUT / "state.json"
LEDGER = OUT / "so_chi.csv"
LOG_FILE = OUT / "nhat_ky.txt"

WS_BASE = __import__("os").environ.get("KTOON_WS_BASE", "https://api.wavespeed.ai/api/v3")
WS_LLM_BASE = __import__("os").environ.get("KTOON_WS_LLM", "https://llm.wavespeed.ai/v1")
ATLAS_BASE = __import__("os").environ.get("KTOON_ATLAS_BASE", "https://api.atlascloud.ai/api/v1/model")
ATLAS_PUB_BASE = __import__("os").environ.get("KTOON_ATLAS_PUB", "https://api.atlascloud.ai/public/v1")
POLL_SLEEP = float(__import__("os").environ.get("KTOON_POLL", "0.4"))
KEY_OF = {"wavespeed": "WAVESPEED_API_KEY", "atlas": "ATLASCLOUD_API_KEY"}
PROVIDER_NAME = {"wavespeed": "WaveSpeed", "atlas": "Atlas Cloud"}

PROJECT = "The Alpha"
PROJECT_SLUG = "The_Alpha"
EPISODE = "EP01"
MAX_GENS_PER_BATCH = 2
DIALOGUE_WPS = 2.3
DIALOGUE_BUFFER_S = 1.0

# ---------------------------------------------------------------- models (giá lấy từ bảng owner đã cho
# trong phiên trước cho đúng 3 model LLM này; giá Seedream text-to-image và Seedance chưa có giá WaveSpeed
# xác nhận riêng cho bản KHÔNG kèm ảnh ref — dùng tạm giá gần nhất đã biết, CẦN xác nhận lại ở lần chạy
# key thật đầu tiên (đúng tinh thần các phần khác của dự án: không vào được wavespeed.ai từ sandbox này).
LLM_CATALOG = [
    {"id": "anthropic/claude-opus-5.5", "label": "Claude Opus 5.5", "price_in": 4.0, "price_out": 20.0},
    {"id": "openai/gpt-6-astra", "label": "GPT-6 Astra", "price_in": 10.0, "price_out": 50.0},
    {"id": "openai/gpt-6-sol", "label": "GPT-6 Sol", "price_in": 2.0, "price_out": 10.0},
]
LLM_PRICE = {m["id"]: (m["price_in"], m["price_out"]) for m in LLM_CATALOG}
DEFAULT_LLM = "anthropic/claude-opus-5.5"

IMAGE_MODEL = "bytedance/seedream-v5.0-pro"
IMAGE_PRICE = 0.0405  # tạm dùng giá bản /edit đã biết — CẦN xác nhận giá bản text-to-image thật

VIDEO_MODELS = [
    {"id": "bytedance/seedance-2.5/reference-to-video", "label": "Seedance 2.5", "price": 0.134},
    {"id": "bytedance/seedance-2.0/reference-to-video", "label": "Seedance 2.0", "price": 0.09},
]
VIDEO_PRICE = {m["id"]: m["price"] for m in VIDEO_MODELS}
DEFAULT_VIDEO_MODEL = VIDEO_MODELS[0]["id"]

CHAR_PROMPT_SYS = """You receive freeform character profiles (possibly several characters, in Vietnamese
and/or English) for a photoreal vertical 9:16 microdrama, and the owner's own template for a single-
character reference-image prompt. Return ONLY one JSON object:
{"characters": [{"name": "character name", "prompt": "ENGLISH image-generation prompt for THIS ONE
character only, following the template's exact structure and voice, one person only, solid plain white
background, no text, no watermark"}, ...]}
Split the profiles into individual characters by name. If no template was given, write a clean, complete,
generic photoreal portrait prompt yourself (still solid white background, one person only). Never merge
two characters into one prompt, never invent a character that is not in the profiles."""

GROUP_SYS = """You receive a raw, already-written shot list (any format, keep it verbatim) for ONE episode
of a vertical 9:16 microdrama, and the list of character names available. Group the shots into video-
generation batches:
- Group consecutive shots that share the same scene/location together into one batch.
- Each batch must be at most 30 seconds of total screen time.
- NEVER split a shot's own dialogue line across two batches — a shot is always kept whole inside one batch.
- Check spoken dialogue against 2.3 words per second of the batch's own duration; if the dialogue would
  need more time than the batch's duration allows, keep the batch as-is but set dialogue_ok=false and
  explain briefly in dialogue_note (never invent extra time or cut the dialogue yourself).
Return ONLY one JSON object:
{"batches": [{"duration": int seconds (<=30), "location": "short location name",
  "characters": ["name", ...] (must match the given character-name list exactly, empty list if none),
  "shots_text": "the exact verbatim shot-list text this batch covers, unchanged",
  "dialogue_text": "every spoken line in this batch concatenated, or empty string if none",
  "dialogue_ok": true|false, "dialogue_note": "short reason, or empty string"}, ...]}
Keep every shot from the input somewhere in some batch — never drop a shot, never invent one that is not
in the input. Order the batches the same order the shots appear in the input."""

VIDEO_PROMPT_SYS = """You write ONE AI video-generation prompt in ENGLISH for a single batch of a vertical
9:16 microdrama, following the owner's own prompt template/example EXACTLY in structure and voice — change
only the scene-specific content (action, dialogue, camera, mood). You are given the exact @ImageN
reference-number mapping for the characters present in this batch: cite exactly those numbers, in that
form, and never invent a reference number of your own. If no template was given, write a clean, complete
prompt yourself in a standard AI-video-prompting structure, still citing the given @ImageN numbers exactly.
Output the final prompt as plain text only, no preamble, no markdown fences, no quotes."""


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


# ---------------------------------------------------------------- keys (yêu cầu #8: tap1\keys.txt trước,
# ~/.ktoon/keys.txt sau — cùng quy tắc và cùng file với tap_thu_v2, nên key đã lưu ở đó dùng lại được luôn)
def ktoon_home_dir():
    return Path.home() / ".ktoon"


def home_keys_file():
    return ktoon_home_dir() / "keys.txt"


def _read_keys_file(p):
    out = {}
    if not p.exists():
        return out
    try:
        for line in p.read_text(encoding="utf-8-sig").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            v = v.strip().strip('"').strip("'")
            if v:
                out[k.strip()] = v
    except OSError:
        pass
    return out


def load_keys():
    merged = dict(_read_keys_file(home_keys_file()))
    merged.update(_read_keys_file(HERE / "keys.txt"))
    return merged


def ensure_keys_file():
    if (HERE / "keys.txt").exists() or home_keys_file().exists():
        return
    home_keys_file().parent.mkdir(parents=True, exist_ok=True)
    home_keys_file().write_text("WAVESPEED_API_KEY=\nATLASCLOUD_API_KEY=\nBUDGET_USD=18\n", encoding="utf-8")


def budget():
    try:
        return float(KEYS.get("BUDGET_USD", "18"))
    except ValueError:
        return 18.0


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


def refresh_balances():
    for p in KEY_OF:
        v = read_balance(p)
        if v is None:
            continue
        with LOCK:
            STATE["balance"][p] = {"now": v, "t": ts()}
    save()


# ---------------------------------------------------------------- state
def fresh_state():
    return {"v": 1, "created": ts(), "project": PROJECT, "episode": EPISODE,
            "profiles_raw": "", "char_tpl": "", "shotlist_raw": "", "video_tpl": "",
            "chars": {}, "char_order": [], "batches": [],
            "settings": {"llm_model": DEFAULT_LLM},
            "jobs": {}, "job_n": 0, "picks": {}, "balance": {}}


def load_state():
    if STATE_FILE.exists():
        st = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        for k, v in fresh_state().items():
            st.setdefault(k, v)
        st["settings"].setdefault("llm_model", DEFAULT_LLM)
        return st
    return fresh_state()


def save():
    with LOCK:
        OUT.mkdir(parents=True, exist_ok=True)
        tmp = STATE_FILE.with_name("state.tmp")
        tmp.write_text(json.dumps(STATE, ensure_ascii=False, indent=1), encoding="utf-8")
        __import__("os").replace(tmp, STATE_FILE)


def ledger(job, event, amount):
    new = not LEDGER.exists()
    try:
        with open(LEDGER, "a", newline="", encoding="utf-8-sig" if new else "utf-8") as f:
            import csv
            w = csv.writer(f)
            if new:
                w.writerow(["thời gian", "việc", "model", "số lượng", "đơn giá USD", "USD", "sự kiện"])
            w.writerow([ts(), job["id"], job.get("model"), job.get("units"), job.get("unit_price"),
                        round(amount, 4), event])
    except OSError as e:
        log(f"Không ghi được so_chi.csv ({e}) — file đang mở trong Excel?")


def S():
    return STATE["settings"]


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


def slug(s, n=30):
    s = re.sub(r"[^a-zA-Z0-9]+", "_", str(s or "")).strip("_")
    return s[:n] or "x"


# ---------------------------------------------------------------- characters (bước 1)
def _new_char_id():
    n = 1
    while f"char_{n}" in STATE["chars"]:
        n += 1
    return f"char_{n}"


def apply_char_prompts(data):
    chars = data.get("characters") or []
    if not chars:
        raise ValueError("Không tách được nhân vật nào.")
    STATE["chars"], STATE["char_order"] = {}, []
    for c in chars:
        name = str(c.get("name") or "").strip()
        if not name:
            continue
        cid = _new_char_id()
        STATE["chars"][cid] = {"id": cid, "name": name, "prompt": str(c.get("prompt") or "").strip(), "approved": False}
        STATE["char_order"].append(cid)


def set_char_prompt(cid, text):
    if cid not in STATE["chars"]:
        raise ApiError(f"Không có nhân vật {cid}.")
    STATE["chars"][cid]["prompt"] = text
    save()


def set_char_approved(cid, approved):
    if cid not in STATE["chars"]:
        raise ApiError(f"Không có nhân vật {cid}.")
    if approved and not pick("char_gen", cid):
        raise ApiError("Chưa có ảnh để duyệt.")
    STATE["chars"][cid]["approved"] = bool(approved)
    save()


# ---------------------------------------------------------------- job engine (take/pick/money — khớp
# tap_thu_v2/pipeline.py, rút gọn: không có "measure giá thật", không có budget theo hạng mục series/tập)
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


def live_takes(kind, target):
    return [j for j in takes(kind, target) if j["status"] not in ("failed", "cancelled")]


def in_progress(kind, target):
    return any(j["status"] in ("queued", "starting", "running") for j in takes(kind, target))


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


def register_local(kind, target, path, meta=None):
    """Ảnh nhân vật owner tự tải lên thay thế — miễn phí, xong ngay, dùng chung máy pick với ảnh máy tạo."""
    with LOCK:
        job = _new_job(kind, target, "local", None, 1, 0.0, f"Tải lên {target}", meta)
        job.update(status="done", cost=0.0, file=str(path.relative_to(OUT)) if path else None, t_end=ts())
        STATE["picks"][f"{kind}:{target}"] = job["id"]
    save()
    ledger(job, "tải lên", 0)
    return job


LLM_KINDS = {"char_prompt", "group", "batch_prompt"}
IMAGE_KINDS = {"char_gen"}
VIDEO_KINDS = {"video_gen"}


# ---------------------------------------------------------------- stage specs (dry-run pricing)
def specs_for(stage, target=None, redo=False):
    st = S()
    model = st["llm_model"]
    pin, pout = LLM_PRICE.get(model, (5.0, 30.0))
    if stage == "char_prompt":
        if not STATE["profiles_raw"].strip():
            return [], "Chưa có hồ sơ nhân vật."
        est = llm_est(pin, pout, len(CHAR_PROMPT_SYS) + len(STATE["profiles_raw"]) + len(STATE["char_tpl"]), 2200)
        return [dict(kind="char_prompt", target="all", provider="wavespeed", model=model, units=1,
                     unit_price=round(est, 4), label="Viết prompt ảnh nhân vật (GPT)")], None
    if stage == "char_gen":
        out = []
        for cid in STATE["char_order"]:
            if target and cid != target:
                continue
            c = STATE["chars"][cid]
            if not redo and live_takes("char_gen", cid):
                continue
            if not c["prompt"].strip():
                if target:
                    return [], f"{c['name']}: chưa có prompt ảnh."
                continue
            out.append(dict(kind="char_gen", target=cid, provider="wavespeed", model=IMAGE_MODEL, units=1,
                             unit_price=IMAGE_PRICE, label=f"Ảnh nhân vật {c['name']}"))
        return out, None
    if stage == "group":
        if not STATE["shotlist_raw"].strip():
            return [], "Chưa có shot list."
        est = llm_est(pin, pout, len(GROUP_SYS) + len(STATE["shotlist_raw"]), 3000)
        return [dict(kind="group", target="ep", provider="wavespeed", model=model, units=1,
                     unit_price=round(est, 4), label="Chia batch (GPT)")], None
    if stage == "batch_prompt":
        out = []
        for i, b in enumerate(STATE["batches"]):
            bid = b["id"]
            if target and bid != target:
                continue
            if not redo and live_takes("batch_prompt", bid):
                continue
            est = llm_est(pin, pout, len(VIDEO_PROMPT_SYS) + len(STATE["video_tpl"]) + len(b.get("shots_text", "")), 900)
            out.append(dict(kind="batch_prompt", target=bid, provider="wavespeed", model=model, units=1,
                             unit_price=round(est, 4), label=f"Viết prompt video {bid}"))
        return out, None
    if stage == "video_gen":
        out = []
        for b in STATE["batches"]:
            bid = b["id"]
            if target and bid != target:
                continue
            if not b.get("prompt", "").strip():
                if target:
                    return [], f"{bid}: chưa có prompt video."
                continue
            if not redo and live_takes("video_gen", bid):
                continue
            if redo and len(live_takes("video_gen", bid)) >= MAX_GENS_PER_BATCH:
                if target:
                    return [], f"{bid}: đã đủ {MAX_GENS_PER_BATCH} lần tạo."
                continue
            model_v = b.get("model", DEFAULT_VIDEO_MODEL)
            price = VIDEO_PRICE.get(model_v, 0.134)
            out.append(dict(kind="video_gen", target=bid, provider="atlas", model=model_v, units=b["duration"],
                             unit_price=price, label=f"Sinh video {bid} · {b['duration']}s"))
        return out, None
    return [], "Bước không hợp lệ."


def create_jobs(stage, target=None, redo=False, dry=False):
    with LOCK:
        specs, err = specs_for(stage, target, redo)
        if err:
            return {"error": err}
        for sp in specs:
            if not KEYS.get(KEY_OF[sp["provider"]]):
                return {"error": f"Chưa có {KEY_OF[sp['provider']]} trong keys.txt."}
        est = round(sum(sp["units"] * sp["unit_price"] for sp in specs), 4)
        spent, reserved = money()
        if specs and spent + reserved + est > budget() + 1e-9:
            return {"error": f"Vượt trần: đã chi ~${spent:.2f} + đang chờ ~${reserved:.2f} + lần này ~${est:.2f} > trần ${budget():.2f}."}
        res = {"n": len(specs), "est": est, "items": [sp["label"] + f" · ~${sp['units'] * sp['unit_price']:.3f}" for sp in specs]}
        if dry or not specs:
            return res
        for sp in specs:
            _new_job(sp["kind"], sp["target"], sp["provider"], sp["model"], sp["units"], sp["unit_price"], sp["label"])
            if redo:
                STATE["picks"].pop(f"{sp['kind']}:{sp['target']}", None)
        save()
        log(f"Xếp hàng {len(specs)} việc ({stage}), ước tính ~${est:.3f}")
        return res


# ---------------------------------------------------------------- batches (bước 2)
def batch_ref_map(b):
    """@ImageN cho các nhân vật CÓ MẶT trong batch và ĐÃ DUYỆT ảnh — app tự tính, GPT không tự bịa số."""
    lines, images = [], []
    for name in b.get("characters") or []:
        cid = next((c["id"] for c in STATE["chars"].values() if c["name"].lower() == str(name).lower()), None)
        c = STATE["chars"].get(cid) if cid else None
        if not c or not c.get("approved"):
            continue
        j = pick("char_gen", cid)
        if not j:
            continue
        images.append((cid, j))
        lines.append(f"@Image{len(images)} = {c['name']}, solid white background reference — keep this exact face/identity")
    return "\n".join(lines), images


def dialogue_fits(dialogue, seconds):
    words = len((dialogue or "").split())
    if not words:
        return True, 0.0
    needed = round(words / DIALOGUE_WPS + DIALOGUE_BUFFER_S, 1)
    return needed <= seconds, needed


def apply_groups(data):
    raw = data.get("batches") or []
    if not raw:
        raise ValueError("Không chia được batch nào.")
    batches = []
    for i, b in enumerate(raw):
        bid = f"B{i + 1:02d}"
        try:
            duration = max(1, min(30, int(round(float(b.get("duration") or 10)))))
        except (TypeError, ValueError):
            duration = 10
        chars = [str(x).strip() for x in (b.get("characters") or []) if str(x).strip()]
        dialogue_text = str(b.get("dialogue_text") or "")
        code_ok, code_needed = dialogue_fits(dialogue_text, duration)
        batches.append({"id": bid, "duration": duration, "location": str(b.get("location") or "").strip(),
                        "characters": chars, "shots_text": str(b.get("shots_text") or "").strip(),
                        "dialogue_text": dialogue_text, "dialogue_ok": bool(b.get("dialogue_ok", True)) and code_ok,
                        "dialogue_note": str(b.get("dialogue_note") or "") or
                                         ("" if code_ok else f"Thoại cần ~{code_needed}s nhưng batch chỉ có {duration}s."),
                        "prompt": "", "model": DEFAULT_VIDEO_MODEL})
    STATE["batches"] = batches


def set_batch_prompt(bid, text):
    b = next((x for x in STATE["batches"] if x["id"] == bid), None)
    if not b:
        raise ApiError(f"Không có batch {bid}.")
    b["prompt"] = text
    save()


def set_batch_model(bid, model):
    if model not in VIDEO_PRICE:
        raise ValueError("Model video không hợp lệ.")
    b = next((x for x in STATE["batches"] if x["id"] == bid), None)
    if not b:
        raise ApiError(f"Không có batch {bid}.")
    b["model"] = model
    save()


# ---------------------------------------------------------------- run / poll (LLM + media — khớp
# tap_thu_v2/pipeline.py's run_llm/run_media, rút gọn: không knowledge library, không "prompt mẫu" đa khe)
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
        model = S()["llm_model"]
    ws = ws_client()
    pin, pout = LLM_PRICE.get(model, (5.0, 30.0))
    if job["kind"] == "char_prompt":
        system = CHAR_PROMPT_SYS + (f"\n\nOwner's template:\n{STATE['char_tpl']}" if STATE["char_tpl"].strip() else "")
        user = "Character profiles:\n\n" + STATE["profiles_raw"]
    elif job["kind"] == "group":
        names = ", ".join(c["name"] for c in STATE["chars"].values()) or "(chưa có nhân vật nào)"
        system = GROUP_SYS
        user = f"Character names available: {names}\n\nShot list:\n\n{STATE['shotlist_raw']}"
    else:  # batch_prompt
        b = next(x for x in STATE["batches"] if x["id"] == job["target"])
        map_text, _images = batch_ref_map(b)
        system = VIDEO_PROMPT_SYS + (f"\n\nOwner's template/example:\n{STATE['video_tpl']}" if STATE["video_tpl"].strip() else "")
        user = (f"Batch {b['id']}: duration {b['duration']}s, location {b['location']}.\n"
                f"Reference mapping (cite exactly these numbers, none else):\n{map_text or '(no approved character images in this batch)'}\n\n"
                f"Shots covered:\n{b['shots_text']}\n\nDialogue in this batch:\n{b['dialogue_text'] or '(none)'}\n"
                "Write the prompt now.")
    log(f"Gọi {model} — có thể mất 20-120 giây…")
    content, usage = ws.chat(model, system, user, job["kind"] in ("char_prompt", "group"))
    pt = usage.get("prompt_tokens") or int((len(system) + len(user)) / 3.5)
    ct = usage.get("completion_tokens") or int(len(content) / 3.5)
    cost = round(pt / 1e6 * pin + ct / 1e6 * pout, 5)
    with LOCK:
        job.update(cost=cost, tokens={"in": pt, "out": ct}, result=content, t_end=ts(), status="done")
        try:
            if job["kind"] == "char_prompt":
                apply_char_prompts(parse_json(content))
            elif job["kind"] == "group":
                apply_groups(parse_json(content))
            else:
                b = next(x for x in STATE["batches"] if x["id"] == job["target"])
                b["prompt"] = content.strip()
        except Exception as e:
            job["status"] = "failed"
            job["error"] = f"Kết quả không đúng định dạng ({e}). Bấm tạo lại."
    save()
    ledger(job, "xong" if job["status"] == "done" else "lỗi định dạng", cost)
    log(f"{'Xong' if job['status'] == 'done' else 'Lỗi'} {jid} · {pt}+{ct} token · ${cost:.4f}")


def _dest_for(job, ext):
    k, t, v = job["kind"], job["target"], job["take"]
    if k == "char_gen":
        name = STATE["chars"].get(t, {}).get("name", t)
        return OUT / "characters" / f"{PROJECT_SLUG}_{slug(name)}_v{v}{ext}"
    if k == "video_gen":
        return OUT / f"{PROJECT_SLUG}_{EPISODE}_{t}_v{v}{ext}"
    return OUT / "media" / k / f"{slug(t)}_t{v}{ext}"


def build_media_body(job):
    k, t = job["kind"], job["target"]
    if k == "char_gen":
        c = STATE["chars"][t]
        return {"prompt": c["prompt"], "aspect_ratio": "9:16", "output_format": "png"}
    if k == "video_gen":
        b = next(x for x in STATE["batches"] if x["id"] == t)
        _map_text, images = batch_ref_map(b)
        body = {"prompt": b["prompt"], "duration": b["duration"], "resolution": "720p", "ratio": "9:16",
                "generate_audio": True, "watermark": False}
        if images:
            body["reference_images"] = [_char_image_url(j) for _cid, j in images]
        return body
    raise ApiError("Loại việc không rõ: " + k)


def _char_image_url(job):
    if job.get("url"):
        return job["url"]
    if not job.get("file"):
        raise ApiError(f"{job.get('id', '?')} chưa có file để dùng làm tham chiếu.")
    full = OUT / job["file"]
    url = ws_client().upload_local(full)
    job["url"] = url
    save()
    return url


def run_media(jid):
    with LOCK:
        job = STATE["jobs"][jid]
        resume = bool(job.get("pid"))
    if not resume:
        body = build_media_body(job)
        with LOCK:
            job.update(body=body, status="running")
    else:
        with LOCK:
            job["status"] = "running"
    is_video = job["kind"] in VIDEO_KINDS
    client = atlas_client() if is_video else ws_client()
    if not resume:
        pid = client.submit_video(job["model"], job["body"]) if is_video else client.submit_media(job["model"], job["body"])
        with LOCK:
            job.update(pid=pid, cost=job["est"], t_submit=time.time(), submitted=ts())
        save()
        ledger(job, "đã gửi", job["est"])
        log(f"Đã gửi {jid} (~${job['est']:.3f})")
    else:
        log(f"Hỏi tiếp {jid} (đã gửi từ trước, không tính tiền lại)")
    limit = (45 if is_video else 15) * 60
    t0 = time.time()
    while True:
        time.sleep(POLL_SLEEP)
        try:
            status, val, _last_frame = client.result(job["pid"])
        except ApiError as e:
            log(f"(chưa hỏi được {jid}: {e}; sẽ hỏi lại)")
            status, val = "running", None
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
    save()
    ext = providers.ext_for(val)
    dest = _dest_for(job, ext)
    try:
        providers.download(val, dest)
        with LOCK:
            job["file"] = str(dest.relative_to(OUT))
    except Exception as e:
        with LOCK:
            job["dl_error"] = scrub(str(e))
        log(f"Tải {jid} về máy thất bại ({e}); vẫn xem được qua link.")
    with LOCK:
        job.update(status="done", t_end=ts())
        STATE["picks"][f"{job['kind']}:{job['target']}"] = job["id"]
    save()
    ledger(job, "xong", 0)
    log(f"Xong {jid}")


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
            idle = not RUNNING and not any(j["status"] == "queued" for j in STATE["jobs"].values())
        if idle:
            refresh_balances()


def scheduler():
    while True:
        time.sleep(0.4)
        try:
            with LOCK:
                queued = sorted((j for j in STATE["jobs"].values() if j["status"] == "queued"), key=lambda j: j["n"])
                for job in queued:
                    if len(RUNNING) >= 2:
                        break
                    job["status"] = "starting"
                    RUNNING.add(job["id"])
                    threading.Thread(target=run_job, args=(job["id"],), daemon=True).start()
        except Exception:
            log(traceback.format_exc())


# ---------------------------------------------------------------- public state (cho UI)
def public_state():
    with LOCK:
        jobs = [{k: j.get(k) for k in ("id", "kind", "target", "take", "status", "model", "est", "cost", "error",
                                        "file", "url", "created", "label", "tokens", "units", "unit_price",
                                        "result", "dl_error", "provider")}
                for j in sorted(STATE["jobs"].values(), key=lambda j: j["n"])]
        todo = {}
        for stage in ("char_prompt", "char_gen", "group", "batch_prompt", "video_gen"):
            specs, err = specs_for(stage)
            todo[stage] = {"n": len(specs), "est": round(sum(sp["units"] * sp["unit_price"] for sp in specs), 4), "error": err}
        return {"project": STATE["project"], "episode": STATE["episode"],
                "profiles_raw": STATE["profiles_raw"], "char_tpl": STATE["char_tpl"],
                "shotlist_raw": STATE["shotlist_raw"], "video_tpl": STATE["video_tpl"],
                "chars": STATE["chars"], "char_order": STATE["char_order"], "batches": STATE["batches"],
                "settings": STATE["settings"], "llm_catalog": LLM_CATALOG, "video_models": VIDEO_MODELS,
                "max_gens_per_batch": MAX_GENS_PER_BATCH, "jobs": jobs, "picks": STATE["picks"], "todo": todo,
                "money": {"spent": money()[0], "reserved": money()[1]}, "budget": budget(),
                "keys": {p: bool(KEYS.get(k)) for p, k in KEY_OF.items()}, "balance": STATE["balance"],
                "running": len(RUNNING)}
