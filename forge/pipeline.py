"""forge — Giai đoạn 1 (Lõi sản xuất) của "Brief: Tool gen video AI tối ưu (phân tích Giant Studio)".
Không có HTTP server ở đây, xem app.py.

Phạm vi (đúng brief, mục "Lộ trình MVP" — chỉ Giai đoạn 1, KHÔNG làm previz/draft/LLM tự chia shot/
timeline duyệt — những cái đó là giai đoạn 2-4):
  Series → Episode → Sequence → Shot, Reference Bank cấp series (asset upload 1 lần, giữ URL provider),
  Style Preset (style lock, negative list, audio rules) trong Bible, prompt compiler bằng TEMPLATE (không
  gọi LLM — brief: "phần cố định ghép bằng template nên không tốn token"), gọi Seedance gen video qua
  Atlas Cloud, pre-flight check trước khi trừ tiền, sổ chi + theo dõi Kept/Re-roll.

Nhà cung cấp: giữ nguyên WaveSpeed (upload ảnh/video ref lấy URL công khai) + Atlas Cloud (Seedance) đã
có key sẵn trong dự án — brief của Giant Studio dùng Avis/Atrium/BytePlus (nhà cung cấp CỦA HỌ), không
phải yêu cầu bắt buộc cho tool này.

Tái dùng nguyên khối job engine (take/pick/resume/ledger/keys) từ tap1/pipeline.py — copy + điều chỉnh
cho khớp Render gắn với Sequence thay vì Batch, không import chéo package khác.
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

ASSET_KINDS = ["character", "location", "keyframe", "style_video", "audio"]
MAX_RENDERS_PER_SEQUENCE = 2  # cùng "giới hạn số lần re-roll HD mỗi shot (vd 2)" của brief §7, áp cho sequence

# ---------------------------------------------------------------- model routing (brief "Bản đồ tính năng")
# Giữ đúng 2 model đã tích hợp + có giá đo thật trong dự án (Seedance 2.5/2.0 qua Atlas). Brief còn nhắc
# 2.0 Fast/Mini/1.5 Pro/1.0 Pro — CHƯA thêm vì chưa có giá xác nhận, tránh đoán giá cho tiền thật.
VIDEO_MODELS = [
    {"id": "bytedance/seedance-2.5/reference-to-video", "label": "Seedance 2.5", "price": 0.134, "ref_limit": 30, "max_duration": 30},
    {"id": "bytedance/seedance-2.0/reference-to-video", "label": "Seedance 2.0", "price": 0.09, "ref_limit": 9, "max_duration": 15},
]
VIDEO_MODEL_BY_ID = {m["id"]: m for m in VIDEO_MODELS}
DEFAULT_VIDEO_MODEL = VIDEO_MODELS[0]["id"]


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


# ---------------------------------------------------------------- keys (forge\keys.txt trước, rồi
# ~/.ktoon/keys.txt — cùng quy ước với tap1/tap_thu_v2 nên key đã lưu ở đó dùng lại được luôn)
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
    home_keys_file().write_text("WAVESPEED_API_KEY=\nATLASCLOUD_API_KEY=\nBUDGET_USD=40\n", encoding="utf-8")


def budget():
    try:
        return float(KEYS.get("BUDGET_USD", "40"))
    except ValueError:
        return 40.0


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


def slug(s, n=40):
    s = re.sub(r"[^a-zA-Z0-9]+", "_", str(s or "")).strip("_")
    return s[:n] or "x"


# ---------------------------------------------------------------- state
def fresh_state():
    return {"v": 1, "created": ts(), "series": {}, "series_order": [], "active_series": "",
            "assets": {}, "episodes": {}, "sequences": {}, "shots": {},
            "jobs": {}, "job_n": 0, "picks": {}, "balance": {}}


def load_state():
    if STATE_FILE.exists():
        st = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        for k, v in fresh_state().items():
            st.setdefault(k, v)
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


# ---------------------------------------------------------------- Series / Bible / Style Preset
def _new_id(bank, prefix):
    n = 1
    while f"{prefix}{n}" in STATE[bank]:
        n += 1
    return f"{prefix}{n}"


def new_series(code, name, budget_usd=40.0):
    sid = _new_id("series", "series_")
    STATE["series"][sid] = {"id": sid, "code": (code or sid).strip(), "name": (name or code or sid).strip(),
                            "budget_usd": float(budget_usd or 40.0),
                            "bible": {"characters": [], "locations": [], "style_lock": "", "negatives": [], "audio_rules": ""},
                            "style_video_asset_id": ""}
    STATE["series_order"].append(sid)
    if not STATE["active_series"]:
        STATE["active_series"] = sid
    save()
    return STATE["series"][sid]


def series(sid):
    s = STATE["series"].get(sid)
    if not s:
        raise ApiError(f"Không có series {sid}.")
    return s


def set_active_series(sid):
    series(sid)
    STATE["active_series"] = sid
    save()


def update_bible(sid, patch):
    b = series(sid)["bible"]
    if "style_lock" in patch:
        b["style_lock"] = str(patch["style_lock"] or "")
    if "audio_rules" in patch:
        b["audio_rules"] = str(patch["audio_rules"] or "")
    if "negatives" in patch:
        b["negatives"] = [str(x).strip() for x in (patch["negatives"] or []) if str(x).strip()]
    if "characters" in patch:
        b["characters"] = [{"name": str(c.get("name") or "").strip(), "desc": str(c.get("desc") or "").strip()}
                           for c in (patch["characters"] or []) if str(c.get("name") or "").strip()]
    if "locations" in patch:
        b["locations"] = [{"name": str(c.get("name") or "").strip(), "desc": str(c.get("desc") or "").strip()}
                          for c in (patch["locations"] or []) if str(c.get("name") or "").strip()]
    save()


def set_series_budget(sid, budget_usd):
    series(sid)["budget_usd"] = float(budget_usd)
    save()


# ---------------------------------------------------------------- Reference Bank (Asset)
def series_assets(sid):
    return [a for a in STATE["assets"].values() if a["series_id"] == sid]


def new_asset(sid, kind, name, data, ext):
    series(sid)
    if kind not in ASSET_KINDS:
        raise ValueError("kind không hợp lệ: " + str(kind))
    name = (name or "").strip()
    if not name:
        raise ValueError("Asset cần có tên (@tên).")
    aid = _new_id("assets", "asset_")
    dest = OUT / "assets" / slug(sid) / f"{slug(kind)}_{slug(name)}_{aid}{ext}"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    STATE["assets"][aid] = {"id": aid, "series_id": sid, "kind": kind, "name": name,
                            "file": str(dest.relative_to(OUT)), "provider_url": "", "created": ts()}
    save()
    log(f"Thêm asset {kind}/@{name} cho {sid}")
    return STATE["assets"][aid]


def remove_asset(aid):
    a = STATE["assets"].get(aid)
    if not a:
        return
    used = [sh for sh in STATE["shots"].values() if aid in sh.get("asset_ids", [])]
    if used:
        raise ApiError(f"Asset @{a['name']} đang được dùng trong {len(used)} shot — bỏ khỏi shot trước khi xoá.")
    STATE["assets"].pop(aid, None)
    save()


def asset_provider_url(asset):
    """Upload lên provider đúng 1 lần, giữ URL — không upload lại mỗi lần gen (brief §4 "Cache và tái sử dụng")."""
    if asset.get("provider_url"):
        return asset["provider_url"]
    full = OUT / asset["file"]
    url = ws_client().upload_local(full)
    asset["provider_url"] = url
    save()
    return url


# ---------------------------------------------------------------- Episode / Sequence / Shot
def new_episode(sid, code, name=""):
    series(sid)
    eid = _new_id("episodes", "ep_")
    order = 1 + sum(1 for e in STATE["episodes"].values() if e["series_id"] == sid)
    STATE["episodes"][eid] = {"id": eid, "series_id": sid, "code": (code or eid).strip(),
                              "name": (name or code or eid).strip(), "order": order}
    save()
    return STATE["episodes"][eid]


def episode(eid):
    e = STATE["episodes"].get(eid)
    if not e:
        raise ApiError(f"Không có episode {eid}.")
    return e


def episode_sequences(eid):
    return sorted((s for s in STATE["sequences"].values() if s["episode_id"] == eid), key=lambda s: s["order"])


def new_sequence(eid, duration_s=15, model_id=None, aspect="9:16", overview=""):
    episode(eid)
    seqid = _new_id("sequences", "seq_")
    order = 1 + len(episode_sequences(eid))
    STATE["sequences"][seqid] = {"id": seqid, "episode_id": eid, "order": order,
                                 "duration_s": max(1, min(30, int(duration_s or 15))),
                                 "model_id": model_id if model_id in VIDEO_MODEL_BY_ID else DEFAULT_VIDEO_MODEL,
                                 "aspect": aspect or "9:16", "overview": overview or ""}
    save()
    return STATE["sequences"][seqid]


def sequence(seqid):
    s = STATE["sequences"].get(seqid)
    if not s:
        raise ApiError(f"Không có sequence {seqid}.")
    return s


def update_sequence(seqid, patch):
    s = sequence(seqid)
    if "duration_s" in patch:
        s["duration_s"] = max(1, min(30, int(patch["duration_s"])))
    if "model_id" in patch and patch["model_id"] in VIDEO_MODEL_BY_ID:
        s["model_id"] = patch["model_id"]
    if "aspect" in patch:
        s["aspect"] = str(patch["aspect"] or "9:16")
    if "overview" in patch:
        s["overview"] = str(patch["overview"] or "")
    save()


def sequence_shots(seqid):
    return sorted((s for s in STATE["shots"].values() if s["sequence_id"] == seqid), key=lambda s: s["order"])


def new_shot(seqid, start_s=0, end_s=4):
    sequence(seqid)
    shid = _new_id("shots", "shot_")
    order = 1 + len(sequence_shots(seqid))
    STATE["shots"][shid] = {"id": shid, "sequence_id": seqid, "order": order,
                            "start_s": float(start_s), "end_s": float(end_s), "framing": "", "camera": "",
                            "action": "", "dialogue": "", "sfx": "", "asset_ids": []}
    save()
    return STATE["shots"][shid]


def shot(shid):
    s = STATE["shots"].get(shid)
    if not s:
        raise ApiError(f"Không có shot {shid}.")
    return s


def update_shot(shid, patch):
    s = shot(shid)
    for k in ("start_s", "end_s"):
        if k in patch:
            s[k] = float(patch[k])
    for k in ("framing", "camera", "action", "dialogue", "sfx"):
        if k in patch:
            s[k] = str(patch[k] or "")
    if "asset_ids" in patch:
        valid = set(STATE["assets"].keys())
        s["asset_ids"] = [aid for aid in (patch["asset_ids"] or []) if aid in valid]
    save()


def remove_shot(shid):
    s = STATE["shots"].pop(shid, None)
    if not s:
        return
    for i, sh in enumerate(sequence_shots(s["sequence_id"]), 1):
        sh["order"] = i
    save()


# ---------------------------------------------------------------- Prompt compiler (brief §3 — TEMPLATE,
# không gọi LLM: "phần cố định ghép bằng template nên không tốn token")
def compile_prompt(seqid):
    seq = sequence(seqid)
    ep = episode(seq["episode_id"])
    ser = series(ep["series_id"])
    shots = sequence_shots(seqid)
    used_ids = []
    for sh in shots:
        for aid in sh["asset_ids"]:
            if aid not in used_ids:
                used_ids.append(aid)
    assets = [STATE["assets"][aid] for aid in used_ids if aid in STATE["assets"]]
    idx_of = {aid: i + 1 for i, aid in enumerate(used_ids)}

    lines = ["[Reference Bank]"]
    if assets:
        for a in assets:
            lines.append(f"@Image{idx_of[a['id']]} = {a['name']} ({a['kind']}) — keep exact identity/style, never alter it")
    else:
        lines.append("(chưa gắn asset nào cho sequence này)")
    lines += ["", "[Target style]", ser["bible"]["style_lock"].strip() or "(chưa đặt style lock trong Bible)"]
    if ser["bible"]["audio_rules"].strip():
        lines += ["", "[Audio] " + ser["bible"]["audio_rules"].strip()]
    lines += ["", f"[Overview] {seq['overview'].strip() or '(chưa có overview)'}", ""]
    for sh in shots:
        refs = [f"@Image{idx_of[aid]}" for aid in sh["asset_ids"] if aid in idx_of]
        parts = [f"[{sh['start_s']:g}-{sh['end_s']:g}s]"]
        if sh["framing"].strip():
            parts.append(sh["framing"].strip() + ",")
        if sh["camera"].strip():
            parts.append(sh["camera"].strip() + ".")
        if sh["action"].strip():
            parts.append(sh["action"].strip())
        if refs:
            parts.append("(" + ", ".join(refs) + ")")
        if sh["dialogue"].strip():
            parts.append(f'Dialogue: "{sh["dialogue"].strip()}"')
        if sh["sfx"].strip():
            parts.append(f"SFX: {sh['sfx'].strip()}")
        lines.append("SHOT " + str(sh["order"]) + " " + " ".join(parts))
    negatives = ser["bible"]["negatives"]
    lines += ["", "[Negative] " + (", ".join(negatives) if negatives else "(chưa đặt danh sách cấm trong Bible)")]
    return "\n".join(lines), used_ids


# ---------------------------------------------------------------- Pre-flight check (brief §5)
def preflight(seqid):
    seq = sequence(seqid)
    shots = sequence_shots(seqid)
    errors = []
    if not shots:
        errors.append("Sequence chưa có shot nào.")
        return errors
    for sh in shots:
        if sh["end_s"] <= sh["start_s"]:
            errors.append(f"Shot {sh['order']}: thời gian kết thúc phải sau thời gian bắt đầu.")
        for aid in sh["asset_ids"]:
            if aid not in STATE["assets"]:
                errors.append(f"Shot {sh['order']}: có asset không tồn tại ({aid}).")
    total = sum(sh["end_s"] - sh["start_s"] for sh in shots)
    if abs(total - seq["duration_s"]) > 0.5:
        errors.append(f"Tổng thời lượng các shot ({total:g}s) không khớp thời lượng sequence ({seq['duration_s']}s).")
    model = VIDEO_MODEL_BY_ID.get(seq["model_id"])
    if not model:
        errors.append("Sequence chưa chọn model video hợp lệ.")
    else:
        used_ids = set()
        for sh in shots:
            used_ids.update(sh["asset_ids"])
        if len(used_ids) > model["ref_limit"]:
            errors.append(f"Số ref ({len(used_ids)}) vượt giới hạn của {model['label']} ({model['ref_limit']}).")
        if seq["duration_s"] > model["max_duration"]:
            errors.append(f"Thời lượng ({seq['duration_s']}s) vượt giới hạn của {model['label']} ({model['max_duration']}s).")
    prompt, _used = compile_prompt(seqid)
    if "</writing>" in prompt or "<writing>" in prompt:
        errors.append("Prompt còn sót thẻ rác kiểu </writing> — kiểm tra lại mô tả hành động trong shot.")
    return errors


# ---------------------------------------------------------------- job engine (take/pick/money — khớp
# tap1/pipeline.py; Render = job kind="render", target=sequence_id)
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


def series_money(sid):
    """Chi + đang chờ chỉ tính trên các sequence thuộc series này (mỗi series tự có ngân sách riêng)."""
    seq_ids = {s["id"] for s in STATE["sequences"].values()
               if episode(s["episode_id"])["series_id"] == sid}
    spent = reserved = 0.0
    for j in STATE["jobs"].values():
        if j["kind"] != "render" or j["target"] not in seq_ids:
            continue
        st = j["status"]
        if st in ("queued", "starting"):
            reserved += j["est"]
        elif st == "running":
            spent += j.get("cost", 0) if j.get("pid") else 0
            reserved += 0 if j.get("pid") else j["est"]
        elif st in ("done", "stalled"):
            spent += j.get("cost", 0)
    return round(spent, 4), round(reserved, 4)


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


def specs_for_render(seqid, redo=False):
    seq = sequence(seqid)
    ep = episode(seq["episode_id"])
    ser = series(ep["series_id"])
    if not redo and live_takes("render", seqid):
        return None, "Sequence này đã có bản render — dùng 'Re-roll' nếu muốn tạo lại."
    if redo and len(live_takes("render", seqid)) >= MAX_RENDERS_PER_SEQUENCE:
        return None, f"Đã đủ {MAX_RENDERS_PER_SEQUENCE} lần render cho sequence này."
    errors = preflight(seqid)
    if errors:
        return None, " | ".join(errors)
    model = VIDEO_MODEL_BY_ID[seq["model_id"]]
    price = model["price"]
    spec = dict(kind="render", target=seqid, provider="atlas", model=seq["model_id"], units=seq["duration_s"],
               unit_price=price, label=f"Render {seqid} · {seq['duration_s']}s ({model['label']})")
    spec["series_budget"] = ser["budget_usd"]
    spec["series_id"] = ser["id"]
    return spec, None


def create_render(seqid, redo=False, dry=False):
    with LOCK:
        spec, err = specs_for_render(seqid, redo)
        if err:
            return {"error": err}
        if not KEYS.get(KEY_OF["atlas"]):
            return {"error": f"Chưa có {KEY_OF['atlas']} trong keys.txt."}
        est = round(spec["units"] * spec["unit_price"], 4)
        spent, reserved = series_money(spec["series_id"])
        if spent + reserved + est > spec["series_budget"] + 1e-9:
            return {"error": f"Vượt trần series: đã chi ~${spent:.2f} + đang chờ ~${reserved:.2f} + lần này ~${est:.2f} > trần ${spec['series_budget']:.2f}."}
        res = {"n": 1, "est": est, "items": [spec["label"] + f" · ~${est:.3f}"]}
        if dry:
            return res
        job = _new_job(spec["kind"], spec["target"], spec["provider"], spec["model"], spec["units"], spec["unit_price"], spec["label"])
        if redo:
            STATE["picks"].pop(f"render:{seqid}", None)
        prompt, used_ids = compile_prompt(seqid)
        job["prompt_compiled"] = prompt
        job["asset_ids"] = used_ids
        job["verdict"] = ""
        job["reason"] = ""
        save()
        log(f"Xếp hàng render {seqid}, ước tính ~${est:.3f}")
        return res


def set_render_verdict(jid, verdict, reason=""):
    j = STATE["jobs"].get(jid)
    if not j or j["kind"] != "render":
        raise ApiError(f"Không có render {jid}.")
    if j["status"] != "done":
        raise ApiError("Chỉ đánh giá được render đã xong.")
    if verdict not in ("kept", "rerolled", ""):
        raise ValueError("verdict không hợp lệ.")
    j["verdict"] = verdict
    j["reason"] = str(reason or "")
    save()


# ---------------------------------------------------------------- run / poll (media only — không có LLM
# trong phase 1, xem docstring đầu file)
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


def _dest_for(job, ext):
    seq = STATE["sequences"].get(job["target"])
    ep = episode(seq["episode_id"]) if seq else None
    ser = series(ep["series_id"]) if ep else None
    fname = f"{slug(ser['code']) if ser else 'x'}_{slug(ep['code']) if ep else 'x'}_{job['target']}_v{job['take']}{ext}"
    return OUT / "renders" / fname


def build_render_body(job):
    seq = sequence(job["target"])
    refs = [asset_provider_url(STATE["assets"][aid]) for aid in job.get("asset_ids", []) if aid in STATE["assets"]]
    body = {"prompt": job["prompt_compiled"], "duration": seq["duration_s"], "resolution": "720p",
            "ratio": seq.get("aspect", "9:16"), "generate_audio": True, "watermark": False}
    if refs:
        body["reference_images"] = refs
    return body


def run_media(jid):
    with LOCK:
        job = STATE["jobs"][jid]
        resume = bool(job.get("pid"))
    if not resume:
        body = build_render_body(job)
        with LOCK:
            job.update(body=body, status="running")
    else:
        with LOCK:
            job["status"] = "running"
    client = atlas_client()
    if not resume:
        pid = client.submit_video(job["model"], job["body"])
        with LOCK:
            job.update(pid=pid, cost=job["est"], t_submit=time.time(), submitted=ts())
        save()
        ledger(job, "đã gửi", job["est"])
        log(f"Đã gửi {jid} (~${job['est']:.3f})")
    else:
        log(f"Hỏi tiếp {jid} (đã gửi từ trước, không tính tiền lại)")
    limit = 45 * 60
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
                                        "file", "url", "created", "label", "units", "unit_price", "dl_error",
                                        "verdict", "reason", "provider", "prompt_compiled")}
                for j in sorted(STATE["jobs"].values(), key=lambda j: j["n"])]
        return {"series": STATE["series"], "series_order": STATE["series_order"], "active_series": STATE["active_series"],
                "assets": STATE["assets"], "episodes": STATE["episodes"], "sequences": STATE["sequences"],
                "shots": STATE["shots"], "asset_kinds": ASSET_KINDS, "video_models": VIDEO_MODELS,
                "max_renders_per_sequence": MAX_RENDERS_PER_SEQUENCE, "jobs": jobs, "picks": STATE["picks"],
                "keys": {p: bool(KEYS.get(k)) for p, k in KEY_OF.items()}, "balance": STATE["balance"],
                "running": len(RUNNING)}
