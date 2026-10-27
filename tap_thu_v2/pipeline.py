"""Trạng thái + logic nghiệp vụ cho tap_thu_v2 (không có HTTP server ở đây, xem app.py).
Luồng theo docs/SPEC_TAP_THU_V2.md §15 (ưu tiên hơn §1-§14 khi mâu thuẫn):
series (kịch bản+shot list, danh sách nhân vật/bối cảnh/prop+style, prompt mẫu, kho ref) ở trên,
danh sách tập (mỗi tập: shot list riêng, batch gen, prompt, video, QC, sửa lỗi, xuất) ở dưới.

Một "job" là một việc tốn tiền hoặc gọi LLM, chạy nền, có thể Resume sau khi tắt app.
Một file owner tải lên/tự có sẵn (component, sheet có sẵn, giọng, video ref, ảnh trong kho ref...)
cũng được ghi thành một "job" giả, provider="local", cost=0, status="done" ngay — để dùng chung máy
chọn phiên bản (takes/pick) với ảnh video do máy tạo ra. Chỉ "components" của nhân vật là danh sách
nhiều item (không phải kiểu chọn 1 bản), vì một nhân vật cần nhiều ảnh thành phần cùng lúc.
"""
import csv
import io
import json
import mimetypes
import os
import re
import shutil
import subprocess
import threading
import time
import traceback
import xml.etree.ElementTree as ET
import zipfile
from datetime import datetime
from pathlib import Path

import providers
from providers import ApiError

HERE = Path(__file__).resolve().parent  # the code folder — never used to store project data (yêu cầu #5.2),
                                         # so replacing the code (by hand or by the self-updater, spec §17)
                                         # never touches keys or data.


def _read_keys_file(p):
    """Pure KEY=VALUE reader, no side effects — used both by load_keys() and to bootstrap DATA_DIR
    before the rest of the module can be defined."""
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


def ktoon_home_dir():
    return Path.home() / ".ktoon"


def home_keys_file():
    return ktoon_home_dir() / "keys.txt"


def _resolve_data_dir():
    """Spec §17 (yêu cầu #5.2): project data lives outside the code folder by default (~/KTOON_DATA),
    changeable via DATA_DIR= in either keys file — the local tap_thu_v2/keys.txt wins per-key over the
    home one, same priority as load_keys(). Needs an app restart to take effect once changed."""
    merged = dict(_read_keys_file(home_keys_file()))
    merged.update(_read_keys_file(HERE / "keys.txt"))
    v = merged.get("DATA_DIR", "").strip()
    return Path(v).expanduser() if v else (Path.home() / "KTOON_DATA")


DATA_DIR = _resolve_data_dir()
OUT = DATA_DIR / "output"
PROJECTS = DATA_DIR / "projects"
EXPORT_DIR = DATA_DIR / "export"
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
KEY_OF = {"wavespeed": "WAVESPEED_API_KEY", "atlas": "ATLASCLOUD_API_KEY", "eachlabs": "EACHLABS_API_KEY"}
PROVIDER_NAME = {"wavespeed": "WaveSpeed", "atlas": "Atlas Cloud", "eachlabs": "each::labs"}
VND_PER_USD = 26170
TARGET_VND = 30_000_000
CONTRACT_VND = 50_000_000
N_EPISODES = 60

IMAGE_PRICE = {"1k": 0.14, "2k": 0.14, "4k": 0.24}
COMPONENT_USES = ["face", "eyes", "hair", "costume", "body", "pose", "other"]

# ---------------------------------------------------------------- model catalog (addendum #4, spec §16)
# Model ids/prices as given by the owner from WaveSpeed's own pricing page (checked by the owner on
# 2026-09-29). This sandbox's network policy blocks wavespeed.ai/api.wavespeed.ai, so this session could
# not independently re-verify them against WaveSpeed's live catalog — re-check on the first real-key run
# (docs/SPEC_TAP_THU_V2.md §12/§16). Prices in USD; LLM prices per 1M tokens (in/out); image prices per image.
LLM_WRITE_CATALOG = [
    {"id": "anthropic/claude-opus-5.5", "label": "Claude Opus 5.5", "price_in": 4.0, "price_out": 20.0, "thinking": True},
    {"id": "openai/gpt-6-astra", "label": "GPT-6 Astra", "price_in": 10.0, "price_out": 50.0, "thinking": True},
    {"id": "openai/gpt-6-sol", "label": "GPT-6 Sol", "price_in": 2.0, "price_out": 10.0, "thinking": True},
    {"id": "anthropic/claude-sonnet-5", "label": "Claude Sonnet 5", "price_in": 2.0, "price_out": 10.0, "thinking": True},
    {"id": "openai/gpt-5.5", "label": "GPT-5.5", "price_in": 5.0, "price_out": 30.0, "thinking": True},
]
LLM_REVIEW_CATALOG = [
    {"id": "google/gemini-3.6-flash", "label": "Gemini 3.6 Flash", "price_in": 0.75, "price_out": 3.8, "vision": True},
]
LLM_MISC_CATALOG = [
    {"id": "openai/gpt-6-luna", "label": "GPT-6 Luna", "price_in": 0.1, "price_out": 0.5},
]
LLM_CATALOGS = {"llm_write": LLM_WRITE_CATALOG, "llm_review": LLM_REVIEW_CATALOG, "llm_misc": LLM_MISC_CATALOG}

_GPT_IMAGE2_PRICE = {f"{q}@{r}": 0.41 for q in ("low", "medium", "high") for r in ("1k", "2k", "4k")}
IMAGE_CATALOG = [
    {"id": "google/nano-banana-pro/edit", "label": "Nano Banana Pro", "price": {"2k": 0.14, "4k": 0.24}},
    {"id": "openai/gpt-image-2/edit", "label": "GPT Image 2", "price": _GPT_IMAGE2_PRICE, "extra_image_price": 0.012,
     "note": "Chỉ high@2k ($0.41) là giá owner xác nhận — các ô khác tạm copy cùng giá, sửa lại trong Cài đặt khi biết giá thật."},
    {"id": "google/nano-banana-2/edit", "label": "Nano Banana 2", "price": {"2k": 0.105, "4k": 0.14}},
    {"id": "bytedance/seedream-v5.0-pro/edit", "label": "Seedream v5.0 Pro", "price": 0.0405},
    {"id": "bytedance/seedream-v5.0-flash/edit", "label": "Seedream v5.0 Flash", "price": 0.0243},
]


def _catalog_lookup(cat_list, model_id):
    return next((dict(m) for m in cat_list if m["id"] == model_id), None)


def llm_catalog_entry(category, model_id):
    """category in llm_write|llm_review|llm_misc. Owner price overrides in Cài đặt (settings.model_prices) win."""
    entry = _catalog_lookup(LLM_CATALOGS.get(category, []), model_id) or \
        {"id": model_id, "label": model_id, "price_in": 5.0, "price_out": 30.0, "thinking": False}
    ov = STATE["settings"].get("model_prices", {}).get(model_id)
    if ov:
        entry.update(ov)
    return entry


def image_catalog_entry(model_id):
    entry = _catalog_lookup(IMAGE_CATALOG, model_id) or {"id": model_id, "label": model_id, "price": IMAGE_PRICE}
    ov = STATE["settings"].get("model_prices", {}).get(model_id)
    if ov:
        entry.update(ov)
    return entry


def llm_price(category, model_id):
    e = llm_catalog_entry(category, model_id)
    return e.get("price_in", 5.0), e.get("price_out", 30.0)


def image_price(model_id, resolution="2k", quality=None):
    e = image_catalog_entry(model_id)
    price = e.get("price", IMAGE_PRICE)
    if isinstance(price, dict):
        key = f"{quality}@{resolution}" if quality else resolution
        if key in price:
            return price[key]
        if resolution in price:
            return price[resolution]
        return next(iter(price.values()), 0.14)
    return float(price)


def image_extra_price(model_id):
    return float(image_catalog_entry(model_id).get("extra_image_price", 0) or 0)


def full_model_catalog():
    """Merged catalog (defaults + owner overrides) for the Cài đặt UI — never mutates STATE."""
    return {
        "llm_write": [llm_catalog_entry("llm_write", m["id"]) for m in LLM_WRITE_CATALOG],
        "llm_review": [llm_catalog_entry("llm_review", m["id"]) for m in LLM_REVIEW_CATALOG],
        "llm_misc": [llm_catalog_entry("llm_misc", m["id"]) for m in LLM_MISC_CATALOG],
        "image": [image_catalog_entry(m["id"]) for m in IMAGE_CATALOG],
    }
TIER_MODEL = {"hook": "bytedance/seedance-2.5/reference-to-video", "cliffhanger": "bytedance/seedance-2.5/reference-to-video",
              "key": "bytedance/seedance-2.5/reference-to-video", "normal": "bytedance/seedance-2.0/reference-to-video"}
TIER_PRICE = {"hook": 0.134, "cliffhanger": 0.134, "key": 0.134, "normal": 0.09}
TIER_MAXDUR = {"hook": 30, "cliffhanger": 30, "key": 30, "normal": 15}
TIER_NAME = {"hook": "hook", "cliffhanger": "cliffhanger", "key": "key (2.5)", "normal": "normal"}

DEFAULT_SETTINGS = {
    "llm_write": "anthropic/claude-opus-5.5", "llm_write_thinking": "",
    "llm_review": "google/gemini-3.6-flash",
    "llm_misc": "openai/gpt-6-luna",
    "image_model_char": "google/nano-banana-pro/edit",
    "image_model_envprop": "google/nano-banana-pro/edit",
    "gpt_image2_quality": "high",
    "image_resolution": "2k", "sheet_resolution": "2k",
    "storyboard_model": "bytedance/seedream-v5.0-flash/edit",
    "resolution": "720p", "max_full_gens": 2, "max_edits_per_image": 10, "parallel": 2,
    "model_prices": {},
}
STAGE_NAME = {"split_episodes": "Tách kịch bản thành các tập", "parse_list": "Đọc file danh sách",
              "preprod": "Đề xuất danh sách tiền kỳ", "reflib_scan": "Quét kho ref",
              "suggest_components": "Gợi ý ảnh thành phần",
              "portrait": "Ảnh nhân vật", "sheet": "Sheet 21:9", "env_wide": "Ảnh bối cảnh",
              "env_rev": "Bối cảnh (góc ngược)", "prop": "Ảnh prop", "voice": "Giọng", "video_ref": "Video ref",
              "storyboard": "Storyboard", "frame": "Cắt khung hình", "fix_img": "Ảnh sửa", "prompt": "Prompt",
              "review": "Duyệt prompt (Gemini)", "gen": "Sinh video", "patch": "Vá đoạn", "critique": "Nhận xét ảnh",
              "condense_knowledge": "Rút gọn tài liệu", "shotlist_from_script": "Viết shot list từ kịch bản (GPT)",
              "kb_librarian": "Thủ thư đọc tài liệu", "video_edit": "AI sửa video (video-editing skill)"}
LLM_KINDS = {"split_episodes", "parse_list", "preprod", "reflib_scan", "suggest_components", "prompt", "review",
             "critique", "condense_knowledge", "shotlist_from_script"}
IMAGE_KINDS = {"portrait", "sheet", "env_wide", "env_rev", "prop", "fix_img", "storyboard"}
EDITABLE_IMAGE_KINDS = {"portrait", "sheet", "env_wide", "env_rev", "prop", "storyboard"}
VIDEO_KINDS = {"gen", "patch"}
SERIES_KINDS = {"portrait", "sheet", "env_wide", "env_rev", "prop", "preprod", "parse_list", "condense_knowledge"}

PROHIBITED = ("no subtitles, no BGM (unless explicitly requested), no exaggerated movements, no extra dialogue, "
              "no runny nose or premature tears, no AI-feel artifacts, no fast cuts when the shot is one continuous take")

VIDEO_EDITING_SKILL_FILE = HERE / "video-editing-SKILL.md"
VIDEO_EDITING_SKILL_FALLBACK = """## Editing Capabilities
Apply color grading, speed changes, style transfer, enhancement, trimming, effects, aspect-ratio changes, and transitions.
## Prompt Tips
Describe the target look with concrete color, contrast, mood, and texture details. Use timestamps for changes tied to moments. For reference-based edits, describe the visual qualities to match.
## Common Pitfalls
Avoid vague requests. Natural-language edits may not produce frame-accurate cuts unless timestamps are supplied. Apply complex effects in stages. Source quality limits enhancement results."""

def video_editing_skill_guidance():
    """Read the installed skill at runtime; keep a safe, shell-free fallback for older self-updaters."""
    try:
        text = VIDEO_EDITING_SKILL_FILE.read_text(encoding="utf-8")
    except OSError:
        text = ""
    sections = []
    for start, end in (("## Editing Capabilities", "## Prompt Tips"),
                       ("## Prompt Tips", "## Examples"),
                       ("## Common Pitfalls", "## Related Skills")):
        i = text.find(start)
        j = text.find(end, i + len(start)) if i >= 0 else -1
        if i >= 0 and j > i:
            section = text[i:j]
            section = re.sub(r"(?s)\x60\x60\x60.*?\x60\x60\x60", "", section).strip()
            if section:
                sections.append(section)
    return "\n\n".join(sections) if sections else VIDEO_EDITING_SKILL_FALLBACK

def video_editing_skill_status():
    return {"name": "video-editing", "available": True,
            "source": "tap_thu_v2/video-editing-SKILL.md" if VIDEO_EDITING_SKILL_FILE.is_file() else "bundled fallback"}

SHOT_SCHEMA = ('{"id": "SH01", "duration": int (4-15 seconds), "location": "short location name", '
               '"cast": ["character name", ...], "props": ["prop name", ...], '
               '"desc": "English action/camera description of this shot", '
               '"speaker": "character name or empty string", "line": "English dialogue or empty string"}')

SPLIT_EPISODES_SYS = """You receive a script and/or shot list for a vertical 9:16 microdrama series, possibly
covering several episodes in one document. Return ONLY one JSON object:
{"episodes": [{"id": "EP01", "name": "short episode title or empty string", "shots": [shot, ...]}, ...]}
where shot = """ + SHOT_SCHEMA + """
Rules:
- Split into episodes wherever the text marks a new one (headings like "EP01", "Episode 2", "Tap 3", a
  clear scene-count reset, or an explicit episode break). If you cannot find any such marker, treat the
  whole input as ONE episode (return a single-item "episodes" list).
- Within one episode, if the input already contains a shot list (prose list or a table), you are a PARSER,
  not a writer: keep exactly the same number of shots, the same order and the same content for that
  episode, only reshaping it into the JSON schema above (guess a sane 4-15s duration only if none was given).
  Never add, remove, merge or drop a shot the input gave you.
- Only invent a fresh shot list yourself (16-20 shots, ~90s total, natural short American-English dialogue)
  for an episode whose text has a screenplay/script but no explicit shot list.
- Number episode ids in order starting at EP01, regardless of what the input calls them."""

# spec §20 item 2a: used only when the owner does not already have a shot list for this episode — the
# real formatting/voice rules should come from the shotlist_rules knowledge-library slot; this is only
# the safety-net fallback for when that slot is still empty.
SHOTLIST_FROM_SCRIPT_SYS = """You turn a screenplay/script excerpt for ONE episode of a vertical 9:16
photoreal microdrama into a Vietnamese shot list, keeping any English dialogue in English. Group shots
under "# SEQUENCE n: <short title>" headings (one per scene/location change), and under each write every
shot as:
## SHOT NN: <short title>
Duration: <seconds>s
Framing: <shot size, e.g. medium close-up>
Camera: <camera move/angle>
Thoại: <English dialogue, or để trống nếu không có thoại>
Character: <tên nhân vật xuất hiện, phân tách bằng dấu phẩy>
SFX: <hiệu ứng âm thanh, hoặc để trống>
Mood: <không khí cảnh quay>
Keep the exact number of shots implied by the source material — do not invent extra beats or drop any.
End with:
SOURCE: <tên/đoạn kịch bản gốc bạn dựa vào>
CONTINUITY NOTE: <điều cần giữ nhất quán cho batch/tập tiếp theo>
Plain text only, in the exact structure above, no extra commentary."""

PARSE_LIST_SYS = """You receive an uploaded/pasted file listing characters, environments, props and a shared
visual style for a photoreal vertical 9:16 microdrama series. Return ONLY one JSON object:
{"characters": [{"name": str, "desc": "English: age, look, wardrobe, personality"}],
 "environments": [{"name": str, "tag": "INT"|"EXT", "time": "day"|"night", "desc": "English set description"}],
 "props": [{"name": str, "desc": "English one-line description"}],
 "style": "the ONE shared style block from the file (e.g. 'ultra realistic 8K Hollywood film...'), in English"}
You are a PARSER: split the given text into these groups faithfully, keep the owner's own wording for
descriptions where given (translate to English only if the source is not English), and do not invent
characters/environments/props/style that are not in the text. If the file uses a table, read it as a table."""

PREPROD_SYS = """You are a production coordinator. From the screenplay, propose the Reference Bank's
characters, environments and props for a photoreal vertical 9:16 microdrama. Return ONLY one JSON object:
{"characters": [{"name": str, "desc": "English: age, look, wardrobe, personality"}],
 "environments": [{"name": str, "tag": "INT"|"EXT", "time": "day"|"night", "desc": "English set description: light, palette, key dressing"}],
 "props": [{"name": str, "desc": "English one-line description"}]}
Only include characters/props/locations that actually appear in the material. Keep descriptions short (1-2
sentences), specific, and filmable."""

REFLIB_TAG_SYS = """You look at one reference image from a character-asset library for an AI video production.
Return ONLY one JSON object: {"label": "short English description, 4-10 words", "use": "face"|"eyes"|"hair"|
"costume"|"body"|"pose"|"other"}. Pick the single "use" tag that best matches what this image is most useful
for as a reference component."""

SUGGEST_COMPONENTS_SYS = """You pick reference-component images for one AI-generated character from a tagged
library. You are given the character's description and a numbered list of available images, each with its
folder source (ai or real) and its use tag. Return ONLY one JSON object: {"picks": [index, ...]}, at most 6
indices, best matching the character's description. HARD RULE: never pick an image whose source is "real"
and whose use is "face" or "eyes" — skip those entirely, even if they otherwise match well."""

TEMPLATE_FILL_SYS = """You fill in an image-generation prompt template for an AI photoreal vertical 9:16
microdrama production, in ENGLISH. Keep the template's exact structure, section order and voice; only
replace the scene/item-specific placeholders with the given item's own details. Always work the shared
style block given to you into the result (append it if the template does not already have a place for it).
If no template is given, just write a clean, complete prompt from the item info and style block yourself,
following standard photoreal AI-image prompting practice. Output the final prompt as plain text only, no
preamble, no markdown, no quotes."""

REWRITE_SYS = """You turn a short user request (Vietnamese or English) for editing ONE existing AI-generated
image into a precise ENGLISH image-edit instruction for an image-edit model. Always state that identity/face,
aspect ratio and background must stay unchanged except for what the user asked to change. Be concrete and
literal; do not add creative flourishes the user did not ask for. Output the instruction as plain text only,
one paragraph, no preamble, no quotes."""

CRITIQUE_SYS = """You look at one reference image for an AI video production (a character sheet, an environment
still, a prop, or a storyboard frame) and list concrete problems only: a missing angle on a sheet, a background
that is not solid white, a malformed hand, an inconsistent face, wrong lighting, anything that would break
downstream generation. If nothing is wrong, say so in one sentence. Plain English text, a short bullet list."""

PROMPT_SYS_DEFAULT = """You write ONE Seedance Omni Reference prompt in ENGLISH for a single AI video generation,
following this exact structure (Seedance 2.5/2.0 reference-to-video master formula):
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

REVIEW_SYS = """You review one Seedance video prompt against its batch JSON (characters, props, beats, dialogue)
for a US vertical microdrama. Return ONLY one JSON object:
{"pass": true|false, "notes": "short English notes: missing beats, wrong @Image/@Audio numbers, dialogue drift,
or empty string if it fully matches"}"""


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
    """Priority (yêu cầu #5.1): tap_thu_v2/keys.txt wins per-key when it has a value; the home-dir file
    (where the Cài đặt "Lưu key" button writes) fills in anything missing there; .env is a last-ditch
    legacy fallback."""
    merged = dict(_read_keys_file(home_keys_file()))
    merged.update(_read_keys_file(HERE / "keys.txt"))
    for k, v in _read_keys_file(HERE / ".env").items():
        merged.setdefault(k, v)
    return merged


def ensure_keys_file():
    """The durable copy lives in the home dir so it survives a code update/replace; tap_thu_v2/keys.txt
    stays supported for reads (existing installs) but is no longer created by default."""
    if (HERE / "keys.txt").exists():
        return
    home = home_keys_file()
    if not home.exists():
        home.parent.mkdir(parents=True, exist_ok=True)
        home.write_text("WAVESPEED_API_KEY=\nATLASCLOUD_API_KEY=\nBUDGET_USD=18\nDATA_DIR=\n", encoding="utf-8")


def mask_key(value):
    if not value:
        return ""
    return "****" + value[-4:] if len(value) > 4 else "****"


def save_home_keys(updates):
    """Write only the given fields into the home-dir keys file (the durable, update-safe copy — yêu cầu
    #5.1), merged with whatever is already there. If a local tap_thu_v2/keys.txt also exists, mirror the
    same fields into it too — load_keys() prefers the local file per-key for backward compat with existing
    installs, so without this a save would silently have no visible effect for anyone who still has one.
    Never logs or returns the values."""
    p = home_keys_file()
    existing = _read_keys_file(p)
    existing.update({k: v for k, v in updates.items() if v is not None})
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text("".join(f"{k}={v}\n" for k, v in existing.items()), encoding="utf-8")
    local = HERE / "keys.txt"
    if local.exists():
        local_existing = _read_keys_file(local)
        local_existing.update({k: v for k, v in updates.items() if v is not None})
        local.write_text("".join(f"{k}={v}\n" for k, v in local_existing.items()), encoding="utf-8")
    log(f"Đã lưu {', '.join(updates.keys())} vào {p}{' và ' + str(local) if local.exists() else ''} (giá trị không hiện trong log).")


def budget():
    try:
        return float(KEYS.get("BUDGET_USD", "18"))
    except ValueError:
        return 18.0


def slug(s, n=20):
    s = re.sub(r"[^a-z0-9]+", "_", str(s or "").lower()).strip("_")
    return s[:n] or "x"


def fresh_state():
    return {"v": 3, "created": ts(), "project": {"name": "DuAn"},
            "script_raw": "", "list_raw": "", "style": "",
            "templates": {"char_single": "", "char_sheet": "", "env": "", "prop": "",
                          "video_structure": "", "video_example": ""},
            "reflib": {"path": "", "scanned": {}},
            "knowledge": {"docs": {}},
            "episodes": {}, "episodes_order": [],
            "chars": {}, "envs": {}, "props": {}, "voices": {}, "video_refs": {},
            "chats": {}, "llm_vision_ok": True,
            "settings": dict(DEFAULT_SETTINGS), "jobs": {}, "picks": {}, "job_n": 0, "asset_v": {},
            "balance": {}, "export": {}}


def load_state():
    if STATE_FILE.exists():
        st = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        fresh = fresh_state()
        for k, v in fresh.items():
            st.setdefault(k, v)
        for k, v in DEFAULT_SETTINGS.items():
            st["settings"].setdefault(k, v)
        for k, v in fresh["templates"].items():
            st["templates"].setdefault(k, v)
        st["knowledge"].setdefault("docs", {})
        for ep in st["episodes"].values():
            ep.setdefault("script_raw", ""), ep.setdefault("shotlist_md", ""), ep.setdefault("shotlist_meta", {})
            for b in ep.get("batches", []):
                b.setdefault("ref_mode", "both")
        return st
    return fresh_state()


def save():
    with LOCK:
        OUT.mkdir(parents=True, exist_ok=True)
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
            w.writerow([ts(), job["id"], job.get("model"), job.get("units"), job.get("unit_price"),
                        round(amount, 4), event])
    except OSError as e:
        log(f"Không ghi được so_chi.csv ({e}) — file đang mở trong Excel?")


def S():
    return STATE["settings"]


# ---------------------------------------------------------------- file text extraction (spec §15 A.1/A.2)
def extract_text(data, filename):
    """.txt/.md/.csv as-is; .docx/.xlsx via zipfile+xml (stdlib only); .pdf refused — paste text instead."""
    ext = Path(filename).suffix.lower()
    if ext in (".txt", ".md", ".csv"):
        return data.decode("utf-8", errors="replace")
    if ext == ".docx":
        return _extract_docx(data)
    if ext == ".xlsx":
        return _extract_xlsx(data)
    if ext == ".pdf":
        raise ValueError("Chưa đọc được PDF — mở file, copy nội dung rồi dán vào ô text thay vì tải PDF lên.")
    raise ValueError(f"Không đọc được đuôi file {ext or '(không rõ)'} — dùng .txt .md .docx .xlsx .csv, hoặc dán text.")


_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def _extract_docx(data):
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        xml = z.read("word/document.xml")
    root = ET.fromstring(xml)
    paras = []
    for p in root.iter(_W + "p"):
        text = "".join(t.text or "" for t in p.iter(_W + "t"))
        paras.append(text)
    return "\n".join(paras)


_SS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def _extract_xlsx(data):
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        shared = []
        if "xl/sharedStrings.xml" in z.namelist():
            sroot = ET.fromstring(z.read("xl/sharedStrings.xml"))
            for si in sroot.iter(_SS + "si"):
                shared.append("".join(t.text or "" for t in si.iter(_SS + "t")))
        sheets = sorted(n for n in z.namelist() if re.match(r"xl/worksheets/sheet\d+\.xml$", n))
        rows_out = []
        for name in sheets:
            root = ET.fromstring(z.read(name))
            for row in root.iter(_SS + "row"):
                cells = []
                for c in row.iter(_SS + "c"):
                    v = c.find(_SS + "v")
                    val = v.text if v is not None else ""
                    if c.get("t") == "s" and val:
                        try:
                            val = shared[int(val)]
                        except (ValueError, IndexError):
                            pass
                    cells.append(val or "")
                rows_out.append("\t".join(cells))
        return "\n".join(rows_out)


# ---------------------------------------------------------------- naming (spec §6, episode-scoped)
def proj_name():
    return slug(STATE["project"]["name"], 40) or "DuAn"


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
    "storyboard": ("02_Production/storyboard", "Storyboard_{name}_v{v}{ext}"),
}


def make_filename(kind, v, ext, name="", label="", extra=None):
    sub, tmpl = NAMING[kind]
    extra = extra or {}
    fn = tmpl.format(name=slug(name, 24), label=slug(label, 16) or "x", res=S().get("image_resolution", "2k").upper(),
                      v=v, ext=ext, **extra)
    return sub, fn


# ---------------------------------------------------------------- reference bank (series-level)
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


def apply_bank_data(data, approved=False):
    """Merge parsed/proposed characters+environments+props (and optionally a style block) into the bank."""
    by_name = lambda bank: {v["name"].lower(): v for v in STATE[bank].values()}
    chars = by_name("chars")
    for c in data.get("characters") or []:
        name = str(c.get("name") or "").strip()
        if not name:
            continue
        if name.lower() in chars:
            chars[name.lower()]["desc"] = chars[name.lower()]["desc"] or str(c.get("desc") or "")
        else:
            new_char(name, str(c.get("desc") or ""), approved=approved)
    envs = by_name("envs")
    for e in data.get("environments") or []:
        name = str(e.get("name") or "").strip()
        if not name:
            continue
        if name.lower() in envs:
            envs[name.lower()]["text"] = envs[name.lower()]["text"] or str(e.get("desc") or "")
        else:
            new_env(name, str(e.get("tag") or "EXT").upper(), str(e.get("time") or "day"), str(e.get("desc") or ""), approved=approved)
    props = by_name("props")
    for p in data.get("props") or []:
        name = str(p.get("name") or "").strip()
        if not name:
            continue
        if name.lower() not in props:
            new_prop(name, str(p.get("desc") or ""), approved=approved)
    if data.get("style") and not STATE["style"].strip():
        STATE["style"] = str(data["style"]).strip()
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


def add_component(char_id, data, ext, label, source, use, reflib_path=None):
    if char_id not in STATE["chars"]:
        raise ValueError("Không có nhân vật này.")
    if source not in ("ai", "real"):
        raise ValueError("source phải là ai hoặc real.")
    if use not in COMPONENT_USES:
        raise ValueError("use không hợp lệ: " + use)
    if source == "real" and use in ("face", "eyes"):
        raise ValueError("Không dùng ảnh người thật cho mặt/mắt (hard rule: chỉ mặt AI).")
    c = STATE["chars"][char_id]
    if reflib_path:
        comp = {"id": f"c{next_version(f'component:{char_id}')}", "file": str(reflib_path), "label": label,
                "source": source, "use": use, "created": ts(), "url": None, "reflib": True}
    else:
        v = next_version(f"component:{char_id}")
        sub, fn = make_filename("component", v, ext, name=c["name"], label=label)
        dest = asset_dest(sub, fn)
        dest.write_bytes(data)
        comp = {"id": f"c{v}", "file": str(dest.relative_to(DATA_DIR)), "label": label, "source": source, "use": use,
                "created": ts(), "url": None}
    c["components"].append(comp)
    save()
    log(f"Thêm component {use}/{source} cho {char_id}: {label}")
    return comp


def remove_component(char_id, comp_id):
    c = STATE["chars"].get(char_id)
    if not c:
        return
    c["components"] = [x for x in c["components"] if x["id"] != comp_id]
    save()


# ---------------------------------------------------------------- reference library (spec §15 A.4)
IMG_EXT = (".jpg", ".jpeg", ".png", ".webp")


def reflib_set_path(path):
    p = Path(str(path)).expanduser()
    if not p.is_dir():
        raise ValueError("Không tìm thấy thư mục này trên máy (đường dẫn phải có trên máy đang chạy app).")
    STATE["reflib"]["path"] = str(p)
    save()
    return {"path": str(p)}


def _reflib_subdir(root, name):
    if not root.is_dir():
        return None
    return next((x for x in root.iterdir() if x.is_dir() and x.name.lower() == name.lower()), None)


def reflib_files():
    """[(abs_path, source), ...] under <reflib path>/AI and <reflib path>/THAT."""
    root = Path(STATE["reflib"]["path"]) if STATE["reflib"]["path"] else None
    out = []
    if not root or not root.is_dir():
        return out
    for name, source in (("AI", "ai"), ("THAT", "real")):
        d = _reflib_subdir(root, name)
        if not d:
            continue
        for f in sorted(d.rglob("*")):
            if f.is_file() and f.suffix.lower() in IMG_EXT:
                out.append((f, source))
    return out


def reflib_key(path):
    st = path.stat()
    return f"{path}::{int(st.st_mtime)}"


def reflib_unscanned():
    scanned = STATE["reflib"]["scanned"]
    return [(p, src) for p, src in reflib_files() if reflib_key(p) not in scanned]


def reflib_candidates(exclude_face_real=True):
    """Tagged entries available for character-component suggestion, as (relkey, path, source, use, label)."""
    out = []
    for key, info in STATE["reflib"]["scanned"].items():
        path = key.rsplit("::", 1)[0]
        if exclude_face_real and info["source"] == "real" and info["use"] in ("face", "eyes"):
            continue
        out.append((key, path, info["source"], info["use"], info["label"]))
    return out


# ---------------------------------------------------------------- knowledge library v2: slots + "librarian"
# spec §20 (yêu cầu #7, bản chốt) — supersedes the type-tagged library of §19 wherever they conflict.
SLOTS = ["shotlist_rules", "project_system", "task_form", "img_char_single", "img_char_sheet", "img_location",
         "img_prop", "video_writer", "video_example", "continue_clip", "repair_image", "review_result",
         "qc_checklist"]
SLOT_NAME = {
    "shotlist_rules": "Quy tắc viết shot list (chung mọi dự án)", "project_system": "Chỉ dẫn hệ thống của dự án",
    "task_form": "Mẫu điền việc (task input)", "img_char_single": "Ảnh nhân vật đơn",
    "img_char_sheet": "Char sheet", "img_location": "Ảnh bối cảnh", "img_prop": "Ảnh prop",
    "video_writer": "Cách viết prompt video", "video_example": "Ví dụ prompt video mẫu",
    "continue_clip": "Nối cảnh (continue clip)", "repair_image": "Sửa ảnh (chat)",
    "review_result": "Nhận xét kết quả", "qc_checklist": "Bảng QC checklist",
}
# Docs whose approved sections resolve only into one of these slots are shared knowledge, not tied to one
# project (spec §20 item 1: the Shotlist Instruction doc is the one example given).
GLOBAL_SLOTS = {"shotlist_rules"}
CONDENSE_WORD_THRESHOLD = 6000

CONDENSE_SYS = """You compress a long reference document into a compact rule set for reuse as a system-
prompt fragment for other LLM calls, preserving every concrete, actionable rule, structure requirement,
and voice/style cue the original states — drop only redundant prose, repeated examples and filler. Keep
the same language as the original. Output plain text only, as short bullet points or short numbered
rules, no preamble, no markdown headers, no meta-commentary about what you did."""

KB_SPLIT_SYS = """You split a reference document into logical sections for a production knowledge library.
Return ONLY one JSON object: {"sections": [{"title": "short title", "text": "the exact original text of
this section, verbatim"}, ...]}. Keep every word of the original text somewhere in the sections (never
summarize or drop content) — split only at natural topic/section boundaries. If the whole document is
really one single topic, return one section covering all of it."""

KB_CLASSIFY_SYS = """You are the librarian for an AI video-production knowledge base. You are given a
numbered list of document sections (title + a short excerpt) and a fixed vocabulary of slots. For EACH
section, return the slot key(s) it belongs to — a section may belong to zero, one, or several slots; use
zero only if the section is truly irrelevant to every slot below. Return ONLY one JSON object:
{"assign": [{"idx": int, "slots": ["slot_key", ...]}, ...]}, one entry per section index given to you.
Valid slot keys and their meaning:
""" + "\n".join(f"- {k}: {v}" for k, v in SLOT_NAME.items())

_HEADER_LINE_RE = [re.compile(r'^#{1,6}\s+\S.*$'), re.compile(r'^§\s*\d+[a-zA-Z]?\b.*$'),
                    re.compile(r'^Section\s+\d+\b.*$', re.IGNORECASE), re.compile(r'^Master\s*0?\d+\b.*$', re.IGNORECASE)]

_SLOT_KEYWORDS = [
    (re.compile(r'master\s*instruction|cinematic literary shotlist workflow', re.I), ["shotlist_rules"]),
    (re.compile(r'§\s*3\b|project instruction', re.I), ["project_system"]),
    (re.compile(r'§\s*2\b|source decisions', re.I), ["project_system"]),
    (re.compile(r'§\s*4\b|reusable task input', re.I), ["task_form"]),
    (re.compile(r'master\s*0?1\b', re.I), ["img_char_single"]),
    (re.compile(r'master\s*0?2\b', re.I), ["img_char_sheet"]),
    (re.compile(r'master\s*0?3\b', re.I), ["img_location"]),
    (re.compile(r'master\s*0?4\b', re.I), ["img_prop"]),
    (re.compile(r'master\s*0?5\b', re.I), ["video_writer"]),
    (re.compile(r'master\s*0?6\b', re.I), ["video_example"]),
    (re.compile(r'continue.?clip|n[ốo]i\s*c[ảa]nh', re.I), ["continue_clip"]),
    (re.compile(r'repair.?image|s[ửư]a\s*[ảa]nh', re.I), ["repair_image"]),
    (re.compile(r'review.?result|nh[ậa]n\s*x[ét][ét]?t', re.I), ["review_result"]),
    (re.compile(r'§\s*12\b|qc\s*checklist', re.I), ["qc_checklist"]),
]


def _keyword_slots(title):
    out = []
    for pat, slots in _SLOT_KEYWORDS:
        if pat.search(title or ""):
            for s in slots:
                if s not in out:
                    out.append(s)
    return out


def _is_header_line(line):
    s = line.strip()
    return bool(s) and any(p.match(s) for p in _HEADER_LINE_RE)


def _split_by_headers(text):
    """Cheap, free, structural split (tried first — spec §20 item 1). Needs at least 2 header lines to be
    worth it; a doc with 0-1 headers falls through to the LLM splitter instead."""
    lines = text.splitlines()
    marks = [i for i, l in enumerate(lines) if _is_header_line(l)]
    if len(marks) < 2:
        return []
    sections = []
    if marks[0] > 0:
        pre = "\n".join(lines[:marks[0]]).strip()
        if pre:
            sections.append({"title": "(mở đầu)", "text": pre})
    for idx, start in enumerate(marks):
        end = marks[idx + 1] if idx + 1 < len(marks) else len(lines)
        sections.append({"title": lines[start].strip(), "text": "\n".join(lines[start:end]).strip()})
    return sections


def _kb_run_split_llm(text):
    ws, st = ws_client(), S()
    content, usage = ws.chat(st["llm_misc"], KB_SPLIT_SYS, "Document:\n\n" + text, True)
    data = parse_json(content)
    out = [{"title": str(s.get("title") or f"Đoạn {i + 1}"), "text": str(s.get("text") or "").strip()}
           for i, s in enumerate(data.get("sections") or []) if str(s.get("text") or "").strip()]
    pin, pout = llm_price("llm_misc", st["llm_misc"])
    pt = usage.get("prompt_tokens") or int((len(KB_SPLIT_SYS) + len(text)) / 3.5)
    ct = usage.get("completion_tokens") or int(len(content) / 3.5)
    return out or [{"title": "(toàn văn)", "text": text}], round(pt / 1e6 * pin + ct / 1e6 * pout, 5)


def _kb_run_classify_llm(sections, idxs):
    ws, st = ws_client(), S()
    listing = "\n".join(f"{i}: {sections[i]['title']} — {sections[i]['text'][:300]}" for i in idxs)
    content, usage = ws.chat(st["llm_misc"], KB_CLASSIFY_SYS, "Sections:\n\n" + listing, True)
    data = parse_json(content)
    got = {}
    for a in data.get("assign") or []:
        try:
            got[int(a["idx"])] = [s for s in (a.get("slots") or []) if s in SLOTS]
        except (KeyError, TypeError, ValueError):
            continue
    pin, pout = llm_price("llm_misc", st["llm_misc"])
    pt = usage.get("prompt_tokens") or int((len(KB_CLASSIFY_SYS) + len(listing)) / 3.5)
    ct = usage.get("completion_tokens") or int(len(content) / 3.5)
    return got, round(pt / 1e6 * pin + ct / 1e6 * pout, 5)


def _kb_llm_affordable(margin=0.05):
    """A conservative pre-check (misc-model librarian calls are cheap but unknown in advance) so a
    knowledge upload never silently blows through the budget cap (hard rule #1)."""
    spent, reserved = money()
    return spent + reserved + margin <= budget() + 1e-9


def librarian_run(kid):
    """Segment + slot-classify a doc's CURRENT version (the "Thủ thư"): heuristic header-split and a
    keyword table run first for free; the misc LLM is only called when a doc has no header structure to
    split on, or a section's slot can't be guessed from its title. Diffs against the doc's previous
    version so the UI can highlight just what changed (spec §20 item 1). Any LLM calls made are logged
    as a real job/ledger entry so they count toward the budget cap, same as every other paid call."""
    doc = knowledge_doc(kid)
    ver = _kb_version(doc)
    if not ver:
        return
    text = ver["raw_text"]
    sections = _split_by_headers(text)
    cost = 0.0
    afford = _kb_llm_affordable()
    if len(sections) < 2:
        if afford:
            try:
                sections, c = _kb_run_split_llm(text)
                cost += c
            except (ApiError, ValueError, KeyError):
                sections = [{"title": "(toàn văn — chia đoạn tự động lỗi, cần chia tay)", "text": text}]
        else:
            sections = [{"title": "(toàn văn — chưa chia được, đã hết trần chi, cần gán tay)", "text": text}]
    guessed = {i: _keyword_slots(sec["title"]) for i, sec in enumerate(sections)}
    ambiguous = [i for i, slots in guessed.items() if not slots]
    if ambiguous and afford:
        try:
            got, c = _kb_run_classify_llm(sections, ambiguous)
            cost += c
            for i in ambiguous:
                guessed[i] = got.get(i) or []
        except (ApiError, ValueError, KeyError):
            pass
    prev_sections = {}
    if len(doc["versions"]) > 1:
        prev_sections = {s["title"]: s["text"] for s in doc["versions"][-2].get("sections", [])}
    out_sections = []
    for i, sec in enumerate(sections):
        changed = prev_sections.get(sec["title"]) != sec["text"]
        out_sections.append({"id": f"s{i}", "title": sec["title"], "text": sec["text"],
                              "slots": guessed.get(i) or [], "approved": True, "changed": changed})
    ver["sections"] = out_sections
    doc["scope"] = _infer_scope(out_sections)
    if cost > 0:
        job = _new_job("kb_librarian", kid, "wavespeed", S()["llm_misc"], 1, cost, f"Thủ thư đọc {doc['name']}")
        job.update(status="done", cost=round(cost, 5), t_end=ts())
        ledger(job, "xong", cost)
    save()


def _infer_scope(sections):
    used = set()
    for s in sections:
        if s["approved"]:
            used.update(s["slots"])
    return "global" if used and used <= GLOBAL_SLOTS else "project"


def knowledge_global_dir():
    d = DATA_DIR / "kien_thuc_chung"
    d.mkdir(parents=True, exist_ok=True)
    return d


def knowledge_project_dir():
    d = project_dir() / "kien_thuc"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _doc_dir(doc):
    base = knowledge_global_dir() if doc.get("scope") == "global" else knowledge_project_dir()
    d = base / doc["id"]
    d.mkdir(parents=True, exist_ok=True)
    return d


def _write_version_file(doc, ver):
    """Mirror the raw/condensed text onto disk under the right scope's folder (spec §20 item 1: project
    docs under KTOON_DATA/projects/<dự án>/kien_thuc, the global shotlist_rules doc under a shared
    folder) — state.json stays the source of truth, this is just for the owner to see the files."""
    try:
        d = _doc_dir(doc)
        (d / f"v{ver['v']}.txt").write_text(ver["raw_text"], encoding="utf-8")
        if ver.get("condensed_text", "").strip():
            (d / f"v{ver['v']}_condensed.txt").write_text(ver["condensed_text"], encoding="utf-8")
    except OSError as e:
        log(f"Không ghi được file tài liệu kiến thức ({e}).")


def _new_kb_id():
    n = 1
    while f"kb_{n}" in STATE["knowledge"]["docs"]:
        n += 1
    return f"kb_{n}"


def knowledge_doc(kid):
    doc = STATE["knowledge"]["docs"].get(kid)
    if not doc:
        raise ApiError(f"Không có tài liệu {kid}.")
    return doc


def add_knowledge_version(kid, text):
    doc = STATE["knowledge"]["docs"][kid]
    v = (doc["versions"][-1]["v"] if doc["versions"] else 0) + 1
    ver = {"v": v, "raw_text": text, "word_count": len(text.split()), "created": ts(),
           "condensed_text": "", "condensed_approved": False, "sections": []}
    doc["versions"].append(ver)
    doc["current_v"] = v
    save()
    librarian_run(kid)
    _write_version_file(doc, ver)
    return v


def new_knowledge_doc(name, text):
    if not text.strip():
        raise ValueError("Tài liệu trống.")
    kid = _new_kb_id()
    STATE["knowledge"]["docs"][kid] = {"id": kid, "name": name or kid, "scope": "project", "versions": [], "current_v": 0}
    save()
    add_knowledge_version(kid, text)
    return STATE["knowledge"]["docs"][kid]


def upload_knowledge(name, text):
    """A file/paste with the SAME name (case-insensitive) as an existing doc is a new version of it —
    re-running the librarian and diffing against the old one; otherwise it is a new doc. The owner is
    never asked to tag a type (spec §20 item 1)."""
    name = (name or "").strip() or "Tài liệu"
    existing = next((d for d in STATE["knowledge"]["docs"].values() if d["name"].strip().lower() == name.lower()), None)
    if existing:
        v = add_knowledge_version(existing["id"], text)
        return existing, v
    doc = new_knowledge_doc(name, text)
    return doc, doc["current_v"]


def set_knowledge_version(kid, v):
    doc = knowledge_doc(kid)
    ver = next((x for x in doc["versions"] if x["v"] == int(v)), None)
    if not ver:
        raise ValueError("Không có phiên bản này.")
    doc["current_v"] = int(v)
    doc["scope"] = _infer_scope(ver.get("sections", []))
    save()


def remove_knowledge_doc(kid):
    STATE["knowledge"]["docs"].pop(kid, None)
    save()


def set_section_slots(kid, sec_id, slots=None, approved=None):
    """The owner's edit/approve pass over the librarian's slot table, and how a slot conflict between two
    docs gets resolved (spec §20 item 1): uncheck 'approved' on the one that should stop counting."""
    doc = knowledge_doc(kid)
    ver = _kb_version(doc)
    if not ver:
        raise ValueError("Tài liệu chưa có nội dung.")
    sec = next((s for s in ver.get("sections", []) if s["id"] == sec_id), None)
    if not sec:
        raise ValueError("Không có đoạn này.")
    if slots is not None:
        sec["slots"] = [s for s in slots if s in SLOTS]
    if approved is not None:
        sec["approved"] = bool(approved)
    doc["scope"] = _infer_scope(ver["sections"])
    save()


def _kb_version(doc, v=None):
    v = v if v is not None else doc["current_v"]
    return next((x for x in doc["versions"] if x["v"] == v), None)


def set_condensed(kid, text, approved):
    doc = knowledge_doc(kid)
    ver = _kb_version(doc)
    if not ver:
        raise ValueError("Tài liệu chưa có nội dung.")
    if text is not None:
        ver["condensed_text"] = text
    ver["condensed_approved"] = bool(approved)
    save()
    _write_version_file(doc, ver)


def active_kb_text(doc, v=None):
    """The text actually usable for this doc's version: the owner-approved condensed rule set if one
    exists, else the raw text — the raw original is never altered (spec §20 item 3)."""
    ver = _kb_version(doc, v)
    if not ver:
        return ""
    if ver.get("condensed_approved") and ver.get("condensed_text", "").strip():
        return ver["condensed_text"]
    return ver["raw_text"]


def slot_text(slot_key):
    """Combined active text for one slot across every doc that has an approved section assigned to it,
    plus the provenance manifest (spec §20 item 6 — every result records which doc+version it used)."""
    parts, used = [], []
    for doc in STATE["knowledge"]["docs"].values():
        ver = _kb_version(doc)
        if not ver:
            continue
        matches = [sec for sec in ver.get("sections", []) if sec["approved"] and slot_key in sec["slots"]]
        if not matches:
            continue
        if ver.get("condensed_approved") and ver.get("condensed_text", "").strip():
            text = ver["condensed_text"]
        else:
            text = "\n\n".join(f"§ {sec['title']}\n{sec['text']}" for sec in matches)
        parts.append(f"--- {doc['name']} ---\n{text}")
        used.append({"slot": slot_key, "id": doc["id"], "name": doc["name"], "v": ver["v"]})
    return "\n\n".join(parts), used


def slot_conflict(slot_key):
    """True when >1 different doc has an approved section claiming the same slot — the owner is asked to
    pick (spec §20 item 1); until resolved, all of them are still combined so the app keeps working."""
    n = 0
    for doc in STATE["knowledge"]["docs"].values():
        ver = _kb_version(doc)
        if ver and any(sec["approved"] and slot_key in sec["slots"] for sec in ver.get("sections", [])):
            n += 1
    return n > 1


def resolve_prompt_source(template_key, slot_key, flat_fallback=None):
    """Priority (spec §20 item 2): the owner's saved 'prompt mẫu' template first, then the knowledge
    library's current versions for this slot, then a flat fallback field, else empty."""
    tmpl = STATE["templates"].get(template_key, "").strip() if template_key else ""
    if tmpl:
        return tmpl, [{"template": template_key}]
    text, used = slot_text(slot_key) if slot_key else ("", [])
    if text.strip():
        return text, used
    if flat_fallback and flat_fallback.strip():
        return flat_fallback.strip(), []
    return "", []


def public_knowledge():
    docs = {}
    for kid, doc in STATE["knowledge"]["docs"].items():
        vers = []
        for v in doc["versions"]:
            vers.append({"v": v["v"], "word_count": v["word_count"], "created": v["created"],
                         "needs_condense": v["word_count"] > CONDENSE_WORD_THRESHOLD, "raw_text": v["raw_text"],
                         "condensed_text": v.get("condensed_text", ""), "condensed_approved": v.get("condensed_approved", False),
                         "est_tokens": int(len(v["raw_text"]) / 3.5),
                         "sections": [{"id": s["id"], "title": s["title"], "slots": s["slots"], "approved": s["approved"],
                                       "changed": s.get("changed", False), "preview": s["text"][:220]}
                                      for s in v.get("sections", [])]})
        docs[kid] = {"id": kid, "name": doc["name"], "scope": doc.get("scope", "project"),
                     "current_v": doc["current_v"], "versions": vers}
    conflicts = [s for s in SLOTS if slot_conflict(s)]
    return docs, conflicts


# ---------------------------------------------------------------- episodes / shots / batches
def new_episode(name=""):
    n = 1
    while f"EP{n:02d}" in STATE["episodes"]:
        n += 1
    eid = f"EP{n:02d}"
    STATE["episodes"][eid] = {"id": eid, "name": name or eid, "shots": [], "batches": [],
                              "prompts": {}, "qc": {}, "fixes": {}, "export": {},
                              "script_raw": "", "shotlist_md": "", "shotlist_meta": {}}
    STATE["episodes_order"].append(eid)
    save()
    return STATE["episodes"][eid]


def episode(eid):
    ep = STATE["episodes"].get(eid)
    if not ep:
        raise ApiError(f"Không có tập {eid}.")
    return ep


def shot_by_id(sid):
    eid = sid.split("-", 1)[0] if "-" in sid else None
    ep = STATE["episodes"].get(eid) if eid else None
    if ep:
        s = next((s for s in ep["shots"] if s["id"] == sid), None)
        if s:
            return s
    for ep in STATE["episodes"].values():
        s = next((s for s in ep["shots"] if s["id"] == sid), None)
        if s:
            return s
    return None


def batch_by_id(bid):
    eid = bid.split("-B", 1)[0] if "-B" in bid else None
    ep = STATE["episodes"].get(eid) if eid else None
    if ep:
        b = next((b for b in ep["batches"] if b["id"] == bid), None)
        if b:
            return ep, b
    for ep in STATE["episodes"].values():
        b = next((b for b in ep["batches"] if b["id"] == bid), None)
        if b:
            return ep, b
    return None, None


def normalize_shots_for_episode(eid, raw_shots, keep_storyboard=True):
    old_by_id = {s["id"]: s for s in episode(eid)["shots"]} if keep_storyboard else {}
    shots = []
    for i, s in enumerate(raw_shots or []):
        if not isinstance(s, dict):
            continue
        base_id = str(s.get("id") or f"SH{i + 1:02d}").strip() or f"SH{i + 1:02d}"
        sid = base_id if base_id.startswith(eid + "-") else f"{eid}-{base_id}"
        try:
            dur = max(4, min(15, int(round(float(s.get("duration") or 6)))))
        except (TypeError, ValueError):
            dur = 6
        old = old_by_id.get(sid, {})
        shots.append({"id": sid, "duration": dur, "location": str(s.get("location") or "").strip(),
                      "cast": [str(x).strip() for x in (s.get("cast") or []) if str(x).strip()],
                      "props": [str(x).strip() for x in (s.get("props") or []) if str(x).strip()],
                      "desc": str(s.get("desc") or "").strip(), "speaker": str(s.get("speaker") or "").strip(),
                      "line": str(s.get("line") or "").strip(), "storyboard_on": bool(old.get("storyboard_on", False))})
    if not shots:
        raise ValueError(f"{eid}: shot list không có shot nào.")
    return shots


def split_batches(eid):
    """Deterministic, free grouping (spec §15 B.8): consecutive same-location shots, capped 30s/15s,
    never splitting a shot. First batch = hook, last = cliffhanger, both default 2.5; the rest default 2.0."""
    shots = episode(eid)["shots"]
    if not shots:
        return []
    groups, cur, cur_loc, cur_dur = [], [], None, 0
    for s in shots:
        if cur and (s["location"] != cur_loc or cur_dur + s["duration"] > 30):
            groups.append(cur)
            cur, cur_dur = [], 0
        cur.append(s)
        cur_dur += s["duration"]
        cur_loc = s["location"]
    if cur:
        groups.append(cur)
    # a batch destined to be "normal" (2.0) must fit 15s — re-split those at shot boundaries
    expanded = []
    for gi, g in enumerate(groups):
        is_end = gi in (0, len(groups) - 1)
        if is_end:
            expanded.append(g)
            continue
        sub, sub_dur = [], 0
        for s in g:
            if sub and sub_dur + s["duration"] > 15:
                expanded.append(sub)
                sub, sub_dur = [], 0
            sub.append(s)
            sub_dur += s["duration"]
        if sub:
            expanded.append(sub)
    batches = []
    n = len(expanded)
    for i, g in enumerate(expanded):
        tier = "hook" if i == 0 else ("cliffhanger" if i == n - 1 else "normal")
        batches.append({"id": f"{eid}-B{i + 1}", "shot_ids": [s["id"] for s in g], "tier": tier,
                        "model": TIER_MODEL[tier], "price": TIER_PRICE[tier],
                        "duration": sum(s["duration"] for s in g), "video_refs": [], "ref_mode": "both"})
    return batches


# ---------------------------------------------------------------- markdown shotlist (spec §20 item 2)
DIALOGUE_WPS = 2.3
DIALOGUE_BUFFER_S = 1.0  # breathing/reaction margin on top of pure read-speed

_SEQ_RE = re.compile(r'^#\s*SEQUENCE\b\s*(\d+)?\s*[:.\-]?\s*(.*)$', re.IGNORECASE)
_SHOT_RE = re.compile(r'^##\s*SHOT\s*(\d+)\s*[:.\-]?\s*(.*)$', re.IGNORECASE)
_FIELD_RE = re.compile(r'^[-*]?\s*(Duration|Framing|Camera|Th[oò]a?i|Dialogue|Character|SFX|Mood)\s*:\s*(.*)$', re.IGNORECASE)
_SOURCE_RE = re.compile(r'^(SOURCE|CONTINUITY NOTE)\s*:\s*(.*)$', re.IGNORECASE)


def parse_shotlist_md(text):
    """'# SEQUENCE'/'## SHOT' markdown shotlist -> [{"seq","title","shots":[...]}], {SOURCE/CONTINUITY_NOTE}
    (spec §20 item 2b). A shot missing Duration gets one estimated from its dialogue length."""
    sequences, meta = [], {}
    cur_seq = cur_shot = None
    for raw_line in (text or "").splitlines():
        line = raw_line.strip()
        m = _SEQ_RE.match(line)
        if m:
            cur_seq = {"seq": m.group(1) or str(len(sequences) + 1), "title": m.group(2).strip(), "shots": []}
            sequences.append(cur_seq)
            cur_shot = None
            continue
        m = _SHOT_RE.match(line)
        if m:
            if cur_seq is None:
                cur_seq = {"seq": "1", "title": "", "shots": []}
                sequences.append(cur_seq)
            cur_shot = {"num": m.group(1), "title": m.group(2).strip(), "duration": None, "framing": "",
                        "camera": "", "dialogue": "", "character": "", "sfx": "", "mood": "", "raw": [raw_line]}
            cur_seq["shots"].append(cur_shot)
            continue
        m = _SOURCE_RE.match(line)
        if m:
            meta[m.group(1).upper().replace(" ", "_")] = m.group(2).strip()
            continue
        if cur_shot is not None:
            cur_shot["raw"].append(raw_line)
            m = _FIELD_RE.match(line)
            if m:
                key, val = m.group(1).lower(), m.group(2).strip()
                if key == "duration":
                    num = re.search(r'[\d.]+', val)
                    cur_shot["duration"] = float(num.group()) if num else None
                elif key.startswith("th") or key == "dialogue":
                    cur_shot["dialogue"] = val
                else:
                    cur_shot[key] = val
    for seq in sequences:
        for shot in seq["shots"]:
            if shot["duration"] is None:
                words = len((shot["dialogue"] or "").split())
                shot["duration"] = round(max(3.0, words / DIALOGUE_WPS + DIALOGUE_BUFFER_S), 1) if words else 4.0
                shot["duration_estimated"] = True
            shot["raw_text"] = "\n".join(shot["raw"]).strip()
    return sequences, meta


def dialogue_fits(dialogue, seconds):
    """2.3 words/s + breathing/reaction margin (spec §20 item 5) — a check only, never an auto-cut."""
    words = len((dialogue or "").split())
    if not words:
        return True, 0.0
    needed = round(words / DIALOGUE_WPS + DIALOGUE_BUFFER_S, 1)
    return needed <= seconds, needed


def batch_dialogue_warnings(ep, b):
    out = []
    for s in batch_shots(ep, b):
        ok, needed = dialogue_fits(s.get("line", ""), s["duration"])
        if not ok:
            out.append(f"{s['id']}: thoại cần ~{needed}s nhưng shot chỉ có {s['duration']}s.")
    return out


def apply_shotlist_md(eid, md_text):
    """Owner-pasted or LLM-written markdown shotlist becomes the episode's shots + sequence-grouped
    batches — replaces the old location-based split for any episode using this new format."""
    ep = episode(eid)
    sequences, meta = parse_shotlist_md(md_text)
    if not any(seq["shots"] for seq in sequences):
        raise ValueError("Không đọc được shot nào (thiếu dòng '## SHOT NN').")
    shots = []
    for seq in sequences:
        for sh in seq["shots"]:
            num = sh["num"] or str(len(shots) + 1)
            sid = f"{eid}-SH{num}"
            cast = [c.strip() for c in re.split(r"[,/]", sh.get("character") or "") if c.strip()]
            shots.append({"id": sid, "duration": sh["duration"], "location": seq["title"] or f"Sequence {seq['seq']}",
                          "cast": cast, "props": [], "desc": (sh.get("framing", "") + " " + sh.get("camera", "")).strip(),
                          "speaker": cast[0] if (cast and sh.get("dialogue")) else "", "line": sh.get("dialogue", ""),
                          "storyboard_on": False, "seq": seq["seq"], "framing": sh.get("framing", ""),
                          "camera": sh.get("camera", ""), "sfx": sh.get("sfx", ""), "mood": sh.get("mood", ""),
                          "raw_text": sh["raw_text"]})
    ep["shotlist_md"] = md_text
    ep["shotlist_meta"] = meta
    ep["shots"] = shots
    ep["batches"] = split_batches_by_sequence(eid)
    save()


def split_batches_by_sequence(eid):
    """Sequence-aware grouping (spec §20 item 2b): never crosses a '# SEQUENCE' boundary, never splits a
    shot (so its dialogue is never split either), capped 30s (fits Seedance 2.5 — a 'normal' tier batch
    over 15s needs a manual re-split to fit 2.0, same convention as split_batches())."""
    shots = episode(eid)["shots"]
    if not shots:
        return []
    groups, cur, cur_seq, cur_dur = [], [], None, 0
    for s in shots:
        seq = s.get("seq")
        if cur and (seq != cur_seq or cur_dur + s["duration"] > 30):
            groups.append(cur)
            cur, cur_dur = [], 0
        cur.append(s)
        cur_dur += s["duration"]
        cur_seq = seq
    if cur:
        groups.append(cur)
    batches = []
    n = len(groups)
    for i, g in enumerate(groups):
        tier = "hook" if i == 0 else ("cliffhanger" if i == n - 1 else "normal")
        batches.append({"id": f"{eid}-B{i + 1}", "shot_ids": [s["id"] for s in g], "tier": tier,
                        "model": TIER_MODEL[tier], "price": TIER_PRICE[tier],
                        "duration": sum(s["duration"] for s in g), "video_refs": [], "ref_mode": "both"})
    return batches


def normalize_batches(eid, raw):
    if not isinstance(raw, list):
        raise ValueError("Batch phải là một danh sách JSON.")
    shots_by_id = {s["id"]: s for s in episode(eid)["shots"]}
    out = []
    for i, b in enumerate(raw):
        if not isinstance(b, dict):
            continue
        bid = str(b.get("id") or f"{eid}-B{i + 1}").strip()
        if not bid.startswith(eid + "-B"):
            bid = f"{eid}-B{i + 1}"
        shot_ids = [str(x).strip() for x in (b.get("shot_ids") or []) if str(x).strip() in shots_by_id]
        if not shot_ids:
            continue
        tier = str(b.get("tier") or "normal").strip().lower()
        if tier not in TIER_MODEL:
            tier = "normal"
        model = str(b.get("model") or TIER_MODEL[tier]).strip()
        try:
            price = float(b.get("price", TIER_PRICE[tier]))
        except (TypeError, ValueError):
            price = TIER_PRICE[tier]
        ref_mode = str(b.get("ref_mode") or "both").strip().lower()
        out.append({"id": bid, "shot_ids": shot_ids, "tier": tier, "model": model, "price": price,
                    "duration": sum(shots_by_id[x]["duration"] for x in shot_ids),
                    "video_refs": [str(x).strip() for x in (b.get("video_refs") or []) if str(x).strip()],
                    "ref_mode": ref_mode if ref_mode in ("single", "sheet", "both") else "both"})
    return out


def batch_index(ep, bid):
    for i, b in enumerate(ep["batches"]):
        if b["id"] == bid:
            return i
    return -1


def set_batch_ref_mode(bid, mode):
    """Per-batch toggle (spec §20 item 4): only single portrait / only sheet / both, to compare."""
    if mode not in ("single", "sheet", "both"):
        raise ValueError("ref_mode phải là single, sheet, hoặc both.")
    _ep, b = batch_by_id(bid)
    if not b:
        raise ApiError(f"Không có batch {bid}.")
    b["ref_mode"] = mode
    save()


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


def batch_shots(ep, b):
    by_id = {s["id"]: s for s in ep["shots"]}
    return [by_id[x] for x in b["shot_ids"] if x in by_id]


def batch_context(ep, b):
    shots = batch_shots(ep, b)
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
    return {"location": location, "characters": chars, "props": props, "beats": beats, "lines": lines}


def build_mapping(bid):
    """Ordered @Image/@Video/@Audio list for one batch, plus the text the LLM is given (never guesses numbers)."""
    ep, b = batch_by_id(bid)
    if not b:
        raise ApiError(f"Không có batch {bid}.")
    ctx = batch_context(ep, b)
    ref_mode = b.get("ref_mode", "both")
    images, videos, audios, lines_txt = [], [], [], []
    for cname in ctx["characters"]:
        c = _find_char(cname)
        if not c:
            continue
        # spec §20 item 4: send BOTH a single-portrait face lock and a turnaround sheet by default, each
        # labeled with its exact scope — never let the sheet be read as a starting frame.
        if ref_mode in ("single", "both"):
            portrait = pick("portrait", c["id"])
            if portrait:
                images.append(("portrait", c["id"], portrait))
                lines_txt.append(f"@Image{len(images)} = {c['name']} face lock (single portrait, solid white background) — identity/face reference only")
        if ref_mode in ("sheet", "both"):
            sheet = pick("sheet", c["id"])
            if sheet:
                images.append(("char_sheet", c["id"], sheet))
                lines_txt.append(f"@Image{len(images)} = {c['name']} turnaround sheet 21:9 — costume/angles/body reference only, NEVER a starting frame")
        for v in STATE["voices"].values():
            if v["char"] == c["id"]:
                vj = pick("voice", v["id"])
                if vj:
                    audios.append(("voice", v["id"], vj))
                    lines_txt.append(f"@Audio{len(audios)} = voice timbre of {c['name']}")
    env = _find_env(ctx["location"])
    if env:
        wide = pick("env_wide", env["id"])
        if wide:
            images.append(("env_wide", env["id"], wide))
            lines_txt.append(f"@Image{len(images)} = Envi_{env['name']} establishing shot")
    for pname in ctx["props"]:
        p = _find_prop(pname)
        if p:
            pj = pick("prop", p["id"])
            if pj:
                images.append(("prop", p["id"], pj))
                lines_txt.append(f"@Image{len(images)} = Prop_{p['name']}")
    for rname in b.get("video_refs") or []:
        r = next((v for v in STATE["video_refs"].values() if v["name"].lower() == rname.lower()), None) or new_video_ref(rname)
        rj = pick("video_ref", r["id"])
        if rj:
            videos.append(("video_ref", r["id"], rj))
            lines_txt.append(f"@Video{len(videos)} = motion/camera reference: {r['name']}")
    for sh in batch_shots(ep, b):
        if sh.get("storyboard_on"):
            sbj = pick("storyboard", sh["id"])
            if sbj:
                images.append(("storyboard", sh["id"], sbj))
                lines_txt.append(f"@Image{len(images)} = storyboard for shot {sh['id']} — composition/pose reference only, keep the face from the character sheet")
    i = batch_index(ep, bid)
    if i > 0:
        prev = ep["batches"][i - 1]
        prevj = pick("gen", prev["id"])
        if prevj and prevj.get("last_frame"):
            images.append(("last_frame", prev["id"], prevj))
            lines_txt.append(f"@Image{len(images)} = last frame of {prev['id']} (raccord continuity)")
    return {"images": images, "videos": videos, "audios": audios, "text": "\n".join(lines_txt), "ctx": ctx}


# ---------------------------------------------------------------- task_form auto-fill (spec §20 item 2c)
TASK_FORM_FALLBACK = """DELIVERABLE: {{DELIVERABLE}}
EPISODE_AND_SHOTS: {{EPISODE_AND_SHOTS}}
APPROVED_SOURCE_EXCERPT:
{{APPROVED_SOURCE_EXCERPT}}

REFERENCE_MAP:
{{REFERENCE_MAP}}

STATE / START_STATE: {{START_STATE}}
OUTPUT_SETTINGS: {{OUTPUT_SETTINGS}}
OUTPUT_MODE: {{OUTPUT_MODE}}
TOOL_LIMITS: {{TOOL_LIMITS}}"""

TOOL_LIMITS_TEXT = {
    "bytedance/seedance-2.5/reference-to-video": "Seedance 2.5 reference-to-video: max 30s per clip, multiple @Image/@Audio/@Video references, 9:16 output.",
    "bytedance/seedance-2.0/reference-to-video": "Seedance 2.0 reference-to-video: max 15s per clip, @Image references only (no @Video), 9:16 output.",
}

_FIELD_TOKEN_RE = re.compile(r'\{\{\s*([A-Z_]+)\s*\}\}')


def _fill_task_form_text(template, fields):
    missing = []

    def repl(m):
        key = m.group(1)
        if key not in fields:
            missing.append(key)
            return m.group(0)
        return str(fields[key])

    return _FIELD_TOKEN_RE.sub(repl, template), missing


def _fill_task_form(bid):
    """Every {{FIELD}} in the task_form slot (or the built-in fallback) is filled by the app itself — the
    owner never has to fill in a placeholder (spec §20 item 2c). Anything the app cannot compute raises a
    clear error asking the owner for it, instead of guessing."""
    ep, b = batch_by_id(bid)
    mapping = build_mapping(bid)
    i = batch_index(ep, bid)
    start_state = "Mở đầu tập (không có trạng thái trước)."
    if i > 0:
        prev = ep["batches"][i - 1]
        if not pick("gen", prev["id"]):
            raise ApiError(f"{bid} nối tiếp {prev['id']} nhưng {prev['id']} chưa có video — chạy {prev['id']} trước.")
        prev_prompt = ep["prompts"].get(prev["id"], {}).get("text", "")
        m = re.search(r'END STATE\s*:?\s*(.*)', prev_prompt, re.IGNORECASE)
        start_state = (m.group(1).strip() if m else prev_prompt[-400:].strip()) or start_state
    shots = batch_shots(ep, b)
    if not shots:
        raise ApiError(f"{bid}: không có shot nào để viết prompt.")
    source_excerpt = "\n\n".join(s.get("raw_text") or f"Shot {s['id']}: {s['desc']}" for s in shots)
    fields = {
        "DELIVERABLE": "VIDEO",
        "EPISODE_AND_SHOTS": f"{ep['id']} — {', '.join(s['id'] for s in shots)}",
        "APPROVED_SOURCE_EXCERPT": source_excerpt,
        "REFERENCE_MAP": mapping["text"] or "(không có tham chiếu nào)",
        "START_STATE": start_state,
        "OUTPUT_SETTINGS": f"9:16, {b['duration']}s",
        "OUTPUT_MODE": "READY_PROMPT_ONLY",
        "TOOL_LIMITS": TOOL_LIMITS_TEXT.get(b["model"], b["model"]),
    }
    tmpl, used = resolve_prompt_source(None, "task_form")
    text, missing = _fill_task_form_text(tmpl or TASK_FORM_FALLBACK, fields)
    if missing:
        raise ApiError("task_form thiếu dữ liệu cho: " + ", ".join(sorted(set(missing))) +
                       " — app không tự điền được, cần bạn bổ sung vào tài liệu task_form.")
    return text, used


def img_url(entry):
    """entry = (kind, id, job). A last_frame reference already has a provider URL; everything else may be local."""
    kind, _id, j = entry
    return j["last_frame"] if kind == "last_frame" else url_of(j)


def url_of(job):
    """A local-only asset (owner upload, ref-library file, ffmpeg frame) needs a public URL before use."""
    if job.get("url"):
        return job["url"]
    if not job.get("file"):
        raise ApiError(f"{job.get('id', '?')} chưa có file để dùng làm tham chiếu.")
    path = Path(job["file"])
    full = path if path.is_absolute() else DATA_DIR / path
    ws = ws_client()
    url = ws.upload_local(full)
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


def eachsense_client():
    return providers.EachSense(key_for("eachlabs"))


def read_balance(provider):
    key = KEYS.get(KEY_OF[provider])
    if not key:
        return None
    try:
        if provider == "wavespeed":
            return providers.WaveSpeed(WS_BASE, WS_LLM_BASE, key).balance()
        if provider == "atlas":
            return providers.Atlas(ATLAS_BASE, ATLAS_PUB_BASE, key).balance()
        return providers.EachSense(key).balance()
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
        elif st in ("done", "stalled") or (st == "failed" and j.get("cost", 0) > 0):
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
        rel = path if (path and Path(path).is_absolute() and not str(path).startswith(str(DATA_DIR))) else (
            str(Path(path).relative_to(DATA_DIR)) if path else None)
        job.update(status="done", cost=0.0, file=rel, t_end=ts())
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


# ---------------------------------------------------------------- providers-facing helpers (chat edit, templates)
ASPECT_OF = {"portrait": "3:4", "sheet": "21:9", "env_wide": "9:16", "env_rev": "9:16", "prop": "1:1", "storyboard": "9:16"}


def chat_rewrite(text):
    ws = ws_client()
    st = S()
    pin, pout = llm_price("llm_misc", st["llm_misc"])
    repair_text, repair_used = slot_text("repair_image")
    system = REWRITE_SYS + (("\n\nFollow this house style for image-edit instructions:\n" + repair_text) if repair_text.strip() else "")
    content, usage = ws.chat(st["llm_misc"], system, text, False)
    pt = usage.get("prompt_tokens") or int((len(system) + len(text)) / 3.5)
    ct = usage.get("completion_tokens") or int(len(content) / 3.5)
    cost = round(pt / 1e6 * pin + ct / 1e6 * pout, 5)
    return content.strip(), cost, repair_used


def template_prompt(template_key, item_context, slot_key=None, override=None):
    """Fill the owner's saved template/knowledge-library slot (spec §15 A.3 + §20 item 2 priority order);
    with neither, fall back to a clean generic prompt. project_system is always prepended (spec §20 item
    1: "MỌI bước LLM viết prompt"). Returns (prompt, cost, knowledge_used manifest)."""
    tmpl_text, tmpl_used = resolve_prompt_source(template_key, slot_key)
    proj_text, proj_used = slot_text("project_system")
    ws = ws_client()
    st = S()
    pin, pout = llm_price("llm_misc", st["llm_misc"])
    user = (f"ITEM INFO:\n{item_context}\n\n" +
            (f"MANDATORY OVERRIDE (this wins over anything the template/reference document below says): {override}\n\n" if override else "") +
            f"SHARED STYLE BLOCK:\n{STATE['style'] or '(none given)'}\n\n"
            f"TEMPLATE:\n{tmpl_text or '(none saved — write a clean prompt yourself)'}")
    system = (proj_text + "\n\n" + TEMPLATE_FILL_SYS) if proj_text.strip() else TEMPLATE_FILL_SYS
    content, usage = ws.chat(st["llm_misc"], system, user, False)
    pt = usage.get("prompt_tokens") or int((len(system) + len(user)) / 3.5)
    ct = usage.get("completion_tokens") or int(len(content) / 3.5)
    cost = round(pt / 1e6 * pin + ct / 1e6 * pout, 5)
    return content.strip(), cost, tmpl_used + proj_used


def build_edit_body(job):
    st = S()
    base = STATE["jobs"].get(job["base_take"])
    if not base:
        raise ApiError("Không còn bản gốc để sửa.")
    rewritten, rewrite_cost, kb_used = chat_rewrite(job["chat_text"])
    refs = [url_of(base)] + [url_of(STATE["jobs"][aid]) for aid in (job.get("attachments") or []) if aid in STATE["jobs"]]
    body = {"prompt": rewritten, "images": refs, "aspect_ratio": ASPECT_OF.get(job["kind"], "9:16"),
            "resolution": job.get("resolution") or st["image_resolution"], "output_format": "jpeg"}
    chat_key = f"{job['kind']}:{job['target']}"
    with LOCK:
        STATE["chats"].setdefault(chat_key, []).append({"role": "assistant", "text": rewritten, "job": job["id"], "t": ts()})
    save()
    return body, rewritten, {"rewrite_cost": rewrite_cost, "knowledge_used": kb_used}




TEMPLATE_EST = 0.02  # flat estimate added to a dry-run when a template-fill LLM call will run first


def build_body(job):
    k, t = job["kind"], job["target"]
    st = S()
    if job.get("edit"):
        return build_edit_body(job)
    if k == "portrait":
        c = STATE["chars"][t]
        if not c["components"]:
            raise ApiError(f"{c['name']}: chưa có ảnh thành phần nào.")
        refs = [url_of(cc) for cc in c["components"]]
        item = f"Character name: {c['name']}. Description: {c['desc'] or 'a fictional adult'}. Output: ONE consistent character portrait on a solid white background, photoreal, 3:4, combining the given reference components (hair/eyes/face/body/costume from the matching tagged references). No text, no watermark."
        prompt, cost, used = template_prompt("char_single", item, "img_char_single")
        return {"prompt": prompt, "images": refs, "aspect_ratio": "3:4", "resolution": st["image_resolution"],
                "output_format": "png"}, prompt, {"components": [cc["id"] for cc in c["components"]], "rewrite_cost": cost, "knowledge_used": used}
    if k == "sheet":
        c = STATE["chars"][t]
        pj = pick("portrait", t)
        item = f"Character name: {c['name']}. Build a 21:9 reference sheet from the uploaded character image: the right 70% shows 4 full-body views (front, 3/4, side, back); the left 30% shows 4 face views (front, 3/4 left, 3/4 right, profile). Keep the exact face and outfit. No text, no watermark."
        # owner decision overrides Master 02's warm-grey background (spec §20 item 3).
        prompt, cost, used = template_prompt("char_sheet", item, "img_char_sheet",
                                             override="the sheet's background MUST be a solid, pure white background — never warm-grey or off-white.")
        return {"prompt": prompt, "images": [url_of(pj)], "aspect_ratio": "21:9", "resolution": st["sheet_resolution"],
                "output_format": "png"}, prompt, {"portrait": pj["id"], "rewrite_cost": cost, "knowledge_used": used}
    if k in ("env_wide", "env_rev"):
        e = STATE["envs"][t]
        angle = "an establishing wide shot" if k == "env_wide" else "the reverse camera angle of the same location"
        when = "night" if e.get("time") == "night" else "day"
        item = f"Environment: {e['name']} ({e.get('tag', 'EXT')}, {when}time). Description: {e['text']}. Output: photoreal vertical 9:16 {angle}. No text, no watermark, no people unless described."
        prompt, cost, used = template_prompt("env", item, "img_location")
        return {"prompt": prompt, "aspect_ratio": "9:16", "resolution": st["image_resolution"],
                "output_format": "jpeg"}, prompt, {"rewrite_cost": cost, "knowledge_used": used}
    if k == "prop":
        p = STATE["props"][t]
        item = f"Prop: {p['name']}. Description: {p.get('desc') or ''}. Output: photoreal product-style still, solid white background, studio light. No text, no watermark."
        prompt, cost, used = template_prompt("prop", item, "img_prop")
        return {"prompt": prompt, "aspect_ratio": "1:1", "resolution": st["image_resolution"], "output_format": "jpeg"}, prompt, {"rewrite_cost": cost, "knowledge_used": used}
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
        item = (f"Shot {sh['id']}: {sh['desc']}. Cast: {', '.join(sh['cast']) or 'none'}. Location: {sh['location']}. "
                "Output: ONE photoreal vertical 9:16 storyboard frame. Keep the exact face and identity of each "
                "character from their sheet reference; use the environment reference for the location's look. "
                "No text, no watermark.")
        prompt, cost, used = template_prompt(None, item, None)
        return {"prompt": prompt, "images": refs, "aspect_ratio": "9:16", "resolution": st["image_resolution"],
                "output_format": "jpeg"}, prompt, {"rewrite_cost": cost, "knowledge_used": used}
    if k == "fix_img":
        f = _find_fix(t)
        frame = pick("frame", t)
        prompt = f["prompt"] or "Fix this frame so it matches the character and scene exactly."
        return {"prompt": prompt, "images": [url_of(frame)], "aspect_ratio": "9:16", "resolution": st["image_resolution"],
                "output_format": "jpeg"}, prompt, {"frame": frame["id"]}
    if k == "gen":
        ep, b = batch_by_id(t)
        mapping = build_mapping(t)
        prompt = ep["prompts"].get(t, {}).get("text") or ""
        body = {"prompt": prompt, "duration": b["duration"], "resolution": st["resolution"], "ratio": "9:16",
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
        f = _find_fix(t)
        ep, b = batch_by_id(f["batch"])
        mapping = build_mapping(f["batch"])
        fix_img = pick("fix_img", t)
        dur = max(4, min(10, f["end"] - f["start"]))
        prompt = (f"{ep['prompts'].get(f['batch'], {}).get('text', '')}\n\nPatch only seconds {f['start']}-{f['end']} "
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


def _find_fix(fid):
    for ep in STATE["episodes"].values():
        if fid in ep["fixes"]:
            return ep["fixes"][fid]
    raise ApiError(f"Không có fix {fid}.")


# ---------------------------------------------------------------- job specs (what a stage would run)
def specs_for(stage, target=None, redo=False):
    st = S()
    if stage == "split_episodes":
        if not STATE["script_raw"].strip():
            return [], "Chưa có kịch bản/shot list."
        pin, pout = llm_price("llm_misc", st["llm_misc"])
        kb_len = len(slot_text("shotlist_rules")[0])
        est = llm_est(pin, pout, len(SPLIT_EPISODES_SYS) + len(STATE["script_raw"]) + kb_len, 4000)
        return [dict(kind="split_episodes", target="ep", provider="wavespeed", model=st["llm_misc"], units=1,
                     unit_price=round(est, 4), label="Tách kịch bản thành các tập")], None
    if stage == "shotlist_from_script":
        if not target or target not in STATE["episodes"]:
            return [], "Không có tập này."
        ep = STATE["episodes"][target]
        if not ep.get("script_raw", "").strip():
            return [], f"{target}: chưa có kịch bản riêng cho tập này (dán ở mục shot list của tập, hoặc dán thẳng shot list nếu đã có sẵn)."
        pin, pout = llm_price("llm_misc", st["llm_misc"])
        kb_len = len(slot_text("shotlist_rules")[0])
        est = llm_est(pin, pout, len(SHOTLIST_FROM_SCRIPT_SYS) + len(ep["script_raw"]) + kb_len, 3000)
        return [dict(kind="shotlist_from_script", target=target, provider="wavespeed", model=st["llm_misc"], units=1,
                     unit_price=round(est, 4), label=f"Viết shot list {target} từ kịch bản (GPT)")], None
    if stage == "parse_list":
        if not STATE["list_raw"].strip():
            return [], "Chưa có file/nội dung danh sách nhân vật-bối cảnh-prop-style."
        pin, pout = llm_price("llm_misc", st["llm_misc"])
        est = llm_est(pin, pout, len(PARSE_LIST_SYS) + len(STATE["list_raw"]), 1600)
        return [dict(kind="parse_list", target="ep", provider="wavespeed", model=st["llm_misc"], units=1,
                     unit_price=round(est, 4), label="Đọc file danh sách")], None
    if stage == "preprod":
        if not STATE["script_raw"].strip():
            return [], "Chưa có kịch bản."
        pin, pout = llm_price("llm_misc", st["llm_misc"])
        est = llm_est(pin, pout, len(PREPROD_SYS) + len(STATE["script_raw"]), 1400)
        return [dict(kind="preprod", target="ep", provider="wavespeed", model=st["llm_misc"], units=1,
                     unit_price=round(est, 4), label="Đề xuất danh sách tiền kỳ (từ kịch bản)")], None
    if stage == "reflib_scan":
        new = reflib_unscanned()
        if not new:
            return [], "Không có ảnh mới trong kho ref (hoặc chưa đặt đường dẫn)."
        pin, pout = llm_price("llm_review", st["llm_review"])
        est = llm_est(pin, pout, len(REFLIB_TAG_SYS), 60)
        return [dict(kind="reflib_scan", target="ep", provider="wavespeed", model=st["llm_review"], units=len(new),
                     unit_price=round(est, 5), label=f"Quét {len(new)} ảnh trong kho ref")], None
    if stage == "suggest_components":
        if not target or target not in STATE["chars"]:
            return [], "Không có nhân vật này."
        if not STATE["reflib"]["scanned"]:
            return [], "Chưa quét kho ref."
        pin, pout = llm_price("llm_misc", st["llm_misc"])
        est = llm_est(pin, pout, len(SUGGEST_COMPONENTS_SYS) + 2000, 200)
        return [dict(kind="suggest_components", target=target, provider="wavespeed", model=st["llm_misc"], units=1,
                     unit_price=round(est, 4), label=f"Gợi ý ảnh thành phần {STATE['chars'][target]['name']}")], None
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
            model = st["image_model_char"]
            price = (image_price(model, resolution=st["image_resolution"], quality=st.get("gpt_image2_quality")) + TEMPLATE_EST +
                     image_extra_price(model) * max(0, len(c["components"]) - 1))
            out.append(dict(kind="portrait", target=c["id"], provider="wavespeed", model=model,
                             units=1, unit_price=round(price, 4), label=f"Ảnh nhân vật {c['name']}"))
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
            model = st["image_model_char"]
            price = image_price(model, resolution=st["sheet_resolution"], quality=st.get("gpt_image2_quality")) + TEMPLATE_EST
            out.append(dict(kind="sheet", target=c["id"], provider="wavespeed", model=model,
                             units=1, unit_price=round(price, 4), label=f"Sheet 21:9 {c['name']}"))
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
            model = st["image_model_envprop"]
            price = image_price(model, resolution=st["image_resolution"], quality=st.get("gpt_image2_quality")) + TEMPLATE_EST
            out.append(dict(kind=stage, target=e["id"], provider="wavespeed", model=model,
                             units=1, unit_price=round(price, 4),
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
            model = st["image_model_envprop"]
            price = image_price(model, resolution=st["image_resolution"], quality=st.get("gpt_image2_quality")) + TEMPLATE_EST
            out.append(dict(kind="prop", target=p["id"], provider="wavespeed", model=model,
                             units=1, unit_price=round(price, 4), label=f"Ảnh prop {p['name']}"))
        return out, None
    if stage == "storyboard":
        out = []
        for ep in STATE["episodes"].values():
            for sh in ep["shots"]:
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
                price = image_price(model, resolution=st["image_resolution"], quality=st.get("gpt_image2_quality")) + TEMPLATE_EST
                out.append(dict(kind="storyboard", target=sh["id"], provider="wavespeed", model=model, units=1,
                                 unit_price=round(price, 4), label=f"Storyboard {sh['id']}"))
        return out, None
    if stage == "critique":
        if not STATE.get("llm_vision_ok", True):
            return [], "LLM không nhận ảnh — đã ẩn nút này."
        kind, tgt = (target or "").split(":", 1) if target and ":" in target else (None, None)
        if not kind or not pick(kind, tgt):
            return [], "Chưa có ảnh để nhận xét."
        pin, pout = llm_price("llm_review", st["llm_review"])
        est = llm_est(pin, pout, len(CRITIQUE_SYS), 300)
        return [dict(kind="critique", target=target, provider="wavespeed", model=st["llm_review"], units=1,
                     unit_price=round(est, 4), label=f"Nhận xét ảnh {target}")], None
    if stage == "condense_knowledge":
        doc = STATE["knowledge"]["docs"].get(target)
        if not doc:
            return [], "Không có tài liệu này."
        ver = _kb_version(doc)
        if not ver or not ver["raw_text"].strip():
            return [], "Tài liệu chưa có nội dung."
        pin, pout = llm_price("llm_misc", st["llm_misc"])
        est = llm_est(pin, pout, len(CONDENSE_SYS) + len(ver["raw_text"]), min(2500, ver["word_count"] * 2))
        return [dict(kind="condense_knowledge", target=target, provider="wavespeed", model=st["llm_misc"], units=1,
                     unit_price=round(est, 4), label=f"Rút gọn {doc['name']}")], None
    if stage in ("prompt", "review"):
        out = []
        for ep in STATE["episodes"].values():
            for b in ep["batches"]:
                is_batch_target = target == b["id"]
                is_ep_target = target == ep["id"]
                if target and not is_batch_target and not is_ep_target:
                    continue
                if not redo and live_takes(stage, b["id"]):
                    continue
                if stage == "review" and not ep["prompts"].get(b["id"], {}).get("text"):
                    if is_batch_target:
                        return [], f"{b['id']}: chưa có prompt."
                    continue
                category = "llm_write" if stage == "prompt" else "llm_review"
                model = st[category]
                price_in, price_out = llm_price(category, model)
                extra_chars = 0
                warns = []
                if stage == "prompt":
                    writer_text = resolve_prompt_source("video_structure", "video_writer")[0]
                    example_text = resolve_prompt_source("video_example", "video_example")[0]
                    proj_text = slot_text("project_system")[0]
                    continue_text = slot_text("continue_clip")[0] if batch_index(ep, b["id"]) > 0 else ""
                    extra_chars = len(writer_text) + len(example_text) + len(proj_text) + len(continue_text)
                    warns = batch_dialogue_warnings(ep, b)
                est = llm_est(price_in, price_out, 1800 + extra_chars, 900)
                label = (STAGE_NAME[stage]) + " " + b["id"] + (" ⚠ thoại dài hơn shot" if warns else "")
                out.append(dict(kind=stage, target=b["id"], provider="wavespeed", model=model, units=1, unit_price=round(est, 4),
                                 label=label))
        return out, None
    if stage == "gen":
        out = []
        for ep in STATE["episodes"].values():
            for i, b in enumerate(ep["batches"]):
                is_batch_target = target == b["id"]
                is_ep_target = target == ep["id"]
                if target and not is_batch_target and not is_ep_target:
                    continue
                if not redo and live_takes("gen", b["id"]):
                    continue
                if not ep["prompts"].get(b["id"], {}).get("approved"):
                    if is_batch_target:
                        return [], f"{b['id']}: prompt chưa được duyệt."
                    continue
                if i > 0:
                    prev = ep["batches"][i - 1]
                    prevj = pick("gen", prev["id"])
                    if not (prevj and prevj.get("last_frame")):
                        if is_batch_target:
                            return [], f"{b['id']} cần khung hình cuối của {prev['id']} trước (chờ {prev['id']} xong)."
                        continue
                model, price = b["model"], float(b["price"])
                spec = dict(kind="gen", target=b["id"], provider="atlas", model=model, units=b["duration"],
                            unit_price=price, label=f"Sinh video {b['id']} · {b['duration']}s")
                if not model_measured(model):
                    spec["measure"] = True
                    spec["label"] += " · đo giá thật lần đầu"
                out.append(spec)
        return out, None
    if stage == "fix_img":
        f = _find_fix_safe(target)
        if not f:
            return [], "Không có fix này."
        if not redo and live_takes("fix_img", target):
            return [], None
        model = S()["image_model_char"]
        return [dict(kind="fix_img", target=target, provider="wavespeed", model=model,
                     units=1, unit_price=round(image_price(model, resolution=S()["image_resolution"], quality=S().get("gpt_image2_quality")), 4),
                     label=f"Ảnh sửa {target}")], None
    if stage == "patch":
        f = _find_fix_safe(target)
        if not f:
            return [], "Không có fix này."
        if not pick("fix_img", target) and not in_progress("fix_img", target):
            return [], f"{target}: chưa có ảnh sửa được duyệt."
        if not redo and live_takes("patch", target):
            return [], None
        _, b = batch_by_id(f["batch"])
        dur = max(4, min(10, f["end"] - f["start"]))
        return [dict(kind="patch", target=target, provider="atlas", model=b["model"], units=dur, unit_price=float(b["price"]),
                     label=f"Vá {f['batch']} {f['start']}-{f['end']}s")], None
    return [], "Bước không hợp lệ."


def _find_fix_safe(fid):
    if not fid:
        return None
    try:
        return _find_fix(fid)
    except ApiError:
        return None


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
        price = image_price(model, resolution=resolution, quality=S().get("gpt_image2_quality"))
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


def create_video_edit_job(source_job_id, prompt, mode="max"):
    """Queue one user-approved video edit with the packaged video-editing skill."""
    prompt = str(prompt or "").strip()
    mode = str(mode or "max").strip().lower()
    if not prompt:
        return {"error": "Hãy mô tả thay đổi video muốn thực hiện."}
    if len(prompt) > 4000:
        return {"error": "Mô tả tối đa 4000 ký tự."}
    if mode not in ("max", "eco"):
        return {"error": "Chất lượng phải là max hoặc eco."}
    with LOCK:
        if not KEYS.get(KEY_OF["eachlabs"]):
            return {"error": "Chưa có EACHLABS_API_KEY. Hãy thêm key each::labs trong Cài đặt."}
        source = STATE["jobs"].get(str(source_job_id or ""))
        if not source or source.get("status") != "done":
            return {"error": "Clip nguồn chưa sẵn sàng hoặc không tồn tại."}
        if source.get("kind") not in ("video_ref", "gen", "patch", "video_edit"):
            return {"error": "Chỉ nhận video tham chiếu hoặc video đã render."}
        if not source.get("url") and not source.get("file"):
            return {"error": "Clip nguồn không có URL hoặc file trên máy."}
        if source.get("file") and not source.get("url") and not KEYS.get(KEY_OF["wavespeed"]):
            return {"error": "Clip đang nằm trên máy; cần WAVESPEED_API_KEY để tạo URL tạm cho each::sense."}
        if any(j.get("provider") == "eachlabs" and j.get("status") in ("queued", "starting", "running")
               for j in STATE["jobs"].values()):
            return {"error": "Đang có một tác vụ each::sense chạy. Chờ xong rồi gửi tiếp."}
        spent, reserved = money()
        if spent + reserved >= budget():
            return {"error": "Đã chạm trần chi phí của lần thử này."}
        job = _new_job("video_edit", source["id"], "eachlabs", "eachsense/beta", 1, 0.0,
                       f"AI sửa video · {source.get('label') or source['id']}",
                       {"base_take": source["id"], "edit_prompt": prompt, "mode": mode,
                        "cost_unknown": True, "skill": "video-editing"})
    save()
    log(f"Xếp hàng sửa video {source['id']} bằng video-editing skill (each::sense, mode={mode})")
    return {"ok": True, "job": job["id"]}


def _video_edit_charge(jid, before, after):
    charge = None
    if before is not None and after is not None:
        delta = round(max(0.0, float(before) - float(after)), 4)
        if delta > 0:
            charge = delta
    with LOCK:
        job = STATE["jobs"].get(jid)
        if not job:
            return None
        if before is not None:
            bal = STATE["balance"].setdefault("eachlabs", {})
            if bal.get("start") is None:
                bal["start"], bal["start_t"] = before, ts()
        if after is not None:
            bal = STATE["balance"].setdefault("eachlabs", {})
            bal["now"], bal["t"] = after, ts()
        if charge is not None:
            job.update(cost=charge, est=charge, unit_price=charge, cost_unknown=False)
            job["measured"] = {"before": before, "after": after, "charge": charge,
                               "note": "Đối chiếu số dư each::labs; số dư có thể cập nhật trễ."}
        else:
            job["cost_unknown"] = True
    save()
    return charge


def run_video_edit(jid):
    with LOCK:
        job = STATE["jobs"].get(jid)
        if not job:
            return
        job["status"] = "running"
        source = STATE["jobs"].get(job.get("base_take"))
        prompt, mode = job.get("edit_prompt", ""), job.get("mode", "max")
    save()
    before = read_balance("eachlabs")
    _video_edit_charge(jid, before, before)
    try:
        if not source or source.get("status") != "done":
            raise ApiError("Không còn clip nguồn đã duyệt.")
        video_url = url_of(source)
        if not video_url.startswith("https://"):
            raise ApiError("Clip nguồn phải có URL HTTPS công khai để gửi tới each::sense.")
        skill = video_editing_skill_guidance()
        output_url, response_text, response = eachsense_client().edit_video(
            video_url, prompt, skill, mode=mode)
        task_id = response.get("task_id")
        with LOCK:
            job = STATE["jobs"][jid]
            job.update(url=output_url, result=response_text, task_id=task_id,
                       submitted=ts(), status="running")
        save()
        ext = providers.ext_for(output_url)
        if ext == ".bin":
            ext = ".mp4"
        dest = _dest_for(job, ext)
        try:
            providers.download(output_url, dest)
            with LOCK:
                job["file"] = str(dest.relative_to(DATA_DIR))
        except Exception as e:
            with LOCK:
                job["dl_error"] = scrub(str(e))
            log(f"Không tải được video đã sửa về máy; vẫn giữ URL xem trước ({e})")
        after = read_balance("eachlabs")
        charge = _video_edit_charge(jid, before, after)
        with LOCK:
            job = STATE["jobs"][jid]
            job.update(status="done", t_end=ts())
            STATE["picks"][f"video_edit:{job['target']}"] = jid
        save()
        ledger(STATE["jobs"][jid], "xong" if charge is not None else "xong — chi phí chưa đối soát", charge or 0)
        log(f"Xong {jid}" + (f" · chi phí đo được {charge:.4f} USD" if charge is not None else " · chi phí each::labs chưa đối soát"))
    except Exception as e:
        after = read_balance("eachlabs")
        charge = _video_edit_charge(jid, before, after)
        finish_fail(jid, str(e), keep_cost=charge is not None)


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
            _new_job(sp["kind"], sp["target"], sp["provider"], sp["model"], sp["units"], sp["unit_price"], sp["label"], extra)
            if redo:
                STATE["picks"].pop(f"{sp['kind']}:{sp['target']}", None)
        save()
        log(f"Xếp hàng {len(specs)} việc ({stage}), ước tính ~${est:.3f}")
        return res


def deps_ready(job):
    k, t = job["kind"], job["target"]
    if k == "sheet" and not pick("portrait", t):
        return (False, None) if in_progress("portrait", t) else (False, f"Thiếu ảnh nhân vật {t}.")
    if k == "gen":
        ep, b = batch_by_id(t)
        i = batch_index(ep, t) if ep else -1
        if i > 0:
            prev = ep["batches"][i - 1]
            prevj = pick("gen", prev["id"])
            if not prevj:
                return (False, None) if in_progress("gen", prev["id"]) else (False, f"Thiếu {prev['id']}.")
            if not prevj.get("last_frame"):
                return False, f"{prev['id']} xong nhưng chưa có khung hình cuối (return_last_frame)."
    if k == "patch":
        if not pick("fix_img", t):
            return (False, None) if in_progress("fix_img", t) else (False, "Thiếu ảnh sửa đã duyệt.")
    return True, None


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
    ledger(STATE["jobs"][jid], "lỗi: " + scrub(err)[:120], STATE["jobs"][jid].get("cost", 0) if keep_cost else 0)
    log(f"LỖI {jid}: {err}")


def run_llm(jid):
    with LOCK:
        job = STATE["jobs"][jid]
        job["status"] = "running"
        st = dict(S())
    ws = ws_client()
    images = None
    reasoning = None
    if job["kind"] == "split_episodes":
        kb_text, kb_used = slot_text("shotlist_rules")
        system = SPLIT_EPISODES_SYS + (("\n\nThe owner's own shot-list style guide/examples — match this "
            "structure and voice for any shot you write yourself:\n" + kb_text) if kb_text.strip() else "")
        job["knowledge_used"] = kb_used
        user = "Script/shot list:\n\n" + STATE["script_raw"] + "\n\nReturn the JSON object now."
        model, jm = st["llm_misc"], True
        pin, pout = llm_price("llm_misc", model)
    elif job["kind"] == "shotlist_from_script":
        eid = job["target"]
        ep = STATE["episodes"][eid]
        kb_text, kb_used = slot_text("shotlist_rules")
        system = kb_text if kb_text.strip() else SHOTLIST_FROM_SCRIPT_SYS
        job["knowledge_used"] = kb_used
        user = f"Episode: {eid}\n\nScript:\n\n{ep['script_raw']}\n\nWrite the Vietnamese shot list now."
        model, jm = st["llm_misc"], False
        pin, pout = llm_price("llm_misc", model)
    elif job["kind"] == "parse_list":
        system, user = PARSE_LIST_SYS, "List file content:\n\n" + STATE["list_raw"] + "\n\nReturn the JSON object now."
        model, jm = st["llm_misc"], True
        pin, pout = llm_price("llm_misc", model)
    elif job["kind"] == "preprod":
        system, user = PREPROD_SYS, "Screenplay:\n\n" + STATE["script_raw"]
        model, jm = st["llm_misc"], True
        pin, pout = llm_price("llm_misc", model)
    elif job["kind"] == "reflib_scan":
        return run_reflib_scan(jid)
    elif job["kind"] == "suggest_components":
        cand = reflib_candidates()
        c = STATE["chars"][job["target"]]
        listing = "\n".join(f"{i}: source={src} use={use} label={label}" for i, (_k, _p, src, use, label) in enumerate(cand))
        system, user = SUGGEST_COMPONENTS_SYS, f"Character description: {c['desc'] or c['name']}\n\nAvailable images:\n{listing}"
        model, jm = st["llm_misc"], True
        pin, pout = llm_price("llm_misc", model)
    elif job["kind"] == "critique":
        kind, tgt = job["target"].split(":", 1)
        j = pick(kind, tgt)
        if not j:
            raise ApiError("Chưa có ảnh để nhận xét.")
        images = [url_of(j)]
        # spec §20 item 3: "Nhận xét" uses review_result (format/voice) + qc_checklist; project_system
        # applies here too (item 1: every prompt-writing/review step).
        review_text, review_used = slot_text("review_result")
        qc_text, qc_used = slot_text("qc_checklist")
        proj_text, proj_used = slot_text("project_system")
        system = CRITIQUE_SYS
        if review_text.strip():
            system += "\n\nFollow this review format/voice:\n" + review_text
        if qc_text.strip():
            system += "\n\nQC checklist to check against:\n" + qc_text
        if proj_text.strip():
            system = proj_text + "\n\n" + system
        job["knowledge_used"] = review_used + qc_used + proj_used
        user = "Critique this reference image."
        model, jm = st["llm_review"], False
        pin, pout = llm_price("llm_review", model)
    elif job["kind"] == "condense_knowledge":
        doc = STATE["knowledge"]["docs"][job["target"]]
        ver = _kb_version(doc)
        system, user = CONDENSE_SYS, f"Document to compress:\n\n{ver['raw_text']}"
        model, jm = st["llm_misc"], False
        pin, pout = llm_price("llm_misc", model)
    elif job["kind"] == "prompt":
        bid = job["target"]
        ep, b = batch_by_id(bid)
        i = batch_index(ep, bid)
        # spec §20 item 2c: system = project_system + video_writer (owner template wins if set); example
        # = video_example; continuing batches also get continue_clip.
        writer_text, writer_used = resolve_prompt_source("video_structure", "video_writer")
        example_text, example_used = resolve_prompt_source("video_example", "video_example")
        proj_text, proj_used = slot_text("project_system")
        continue_text, continue_used = slot_text("continue_clip") if i > 0 else ("", [])
        parts = []
        if proj_text.strip():
            parts.append(proj_text)
        parts.append(writer_text if writer_text.strip() else PROMPT_SYS_DEFAULT)
        if i > 0 and continue_text.strip():
            parts.append("This batch continues a previous one — follow this continuation rule:\n" + continue_text)
        if example_text.strip():
            parts.append("Example of a finished prompt in this exact structure/voice:\n" + example_text)
        parts.append("Cite the exact @Image/@Audio/@Video numbers given to you, never invent one. Always "
                      "end with: Prohibited: " + PROHIBITED + ".")
        system = "\n\n".join(parts)
        user, form_used = _fill_task_form(bid)
        job["knowledge_used"] = proj_used + writer_used + example_used + continue_used + form_used
        model, jm = st["llm_write"], False
        pin, pout = llm_price("llm_write", model)
        if st.get("llm_write_thinking") and llm_catalog_entry("llm_write", model).get("thinking"):
            reasoning = st["llm_write_thinking"]
    else:  # review
        bid = job["target"]
        ep, b = batch_by_id(bid)
        mapping = build_mapping(bid)
        proj_text, proj_used = slot_text("project_system")
        qc_text, qc_used = slot_text("qc_checklist")
        system = REVIEW_SYS
        if qc_text.strip():
            system += "\n\nQC checklist to enforce:\n" + qc_text
        if proj_text.strip():
            system = proj_text + "\n\n" + system
        job["knowledge_used"] = proj_used + qc_used
        user = (f"Prompt:\n{ep['prompts'].get(bid, {}).get('text', '')}\n\nBatch JSON subset:\n"
                f"{json.dumps({'beats': mapping['ctx']['beats'], 'lines': mapping['ctx']['lines']}, ensure_ascii=False)}")
        model, jm = st["llm_review"], True
        pin, pout = llm_price("llm_review", model)
    log(f"Gọi {model} ({STAGE_NAME[job['kind']]}) — có thể mất 20-120 giây…")
    try:
        content, usage = ws.chat(model, system, user, jm, images=images, reasoning=reasoning)
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
            if job["kind"] == "split_episodes":
                apply_split_episodes(parse_json(content))
            elif job["kind"] == "shotlist_from_script":
                apply_shotlist_md(job["target"], content.strip())
            elif job["kind"] == "parse_list":
                apply_bank_data(parse_json(content), approved=False)
            elif job["kind"] == "preprod":
                apply_bank_data(parse_json(content), approved=False)
            elif job["kind"] == "suggest_components":
                apply_suggested_components(job["target"], parse_json(content))
            elif job["kind"] == "prompt":
                ep, b = batch_by_id(job["target"])
                ep["prompts"].setdefault(job["target"], {})["text"] = content
                ep["prompts"][job["target"]]["approved"] = False
            elif job["kind"] == "review":
                ep, b = batch_by_id(job["target"])
                d = parse_json(content)
                ep["prompts"].setdefault(job["target"], {})["review"] = d
            elif job["kind"] == "critique":
                chat_key = job["target"]
                STATE["chats"].setdefault(chat_key, []).append({"role": "critique", "text": content, "job": jid, "t": ts()})
            elif job["kind"] == "condense_knowledge":
                doc = STATE["knowledge"]["docs"].get(job["target"])
                if doc:
                    ver = _kb_version(doc)
                    if ver:
                        ver["condensed_text"] = content.strip()
                        ver["condensed_approved"] = False
                        _write_version_file(doc, ver)
        except Exception as e:
            job["status"] = "failed"
            job["error"] = f"Kết quả không đúng định dạng ({e}). Bấm tạo lại."
    save()
    ledger(job, "xong" if job["status"] == "done" else "lỗi định dạng", cost)
    log(f"{'Xong' if job['status'] == 'done' else 'Lỗi'} {jid} · {pt}+{ct} token · ${cost:.4f}")


def apply_split_episodes(data):
    eps = data.get("episodes") or []
    if not eps:
        raise ValueError("Không tách được tập nào.")
    for i, e in enumerate(eps):
        eid = str(e.get("id") or f"EP{i + 1:02d}").strip() or f"EP{i + 1:02d}"
        if not re.match(r"^EP\d+$", eid):
            eid = f"EP{i + 1:02d}"
        if eid not in STATE["episodes"]:
            STATE["episodes"][eid] = {"id": eid, "name": str(e.get("name") or eid), "shots": [], "batches": [],
                                      "prompts": {}, "qc": {}, "fixes": {}, "export": {},
                                      "script_raw": "", "shotlist_md": "", "shotlist_meta": {}}
            STATE["episodes_order"].append(eid)
        STATE["episodes"][eid]["shots"] = normalize_shots_for_episode(eid, e.get("shots") or [])
        STATE["episodes"][eid]["batches"] = split_batches(eid)


def apply_suggested_components(char_id, data):
    cand = reflib_candidates()
    picks = data.get("picks") or []
    c = STATE["chars"][char_id]
    have = {cc["file"] for cc in c["components"]}
    for idx in picks:
        try:
            _key, path, source, use, label = cand[int(idx)]
        except (ValueError, IndexError, TypeError):
            continue
        if source == "real" and use in ("face", "eyes"):
            continue  # hard rule, enforced again here even though the prompt already says so
        if path in have:
            continue
        c["components"].append({"id": f"c{next_version(f'component:{char_id}')}", "file": path, "label": label,
                                "source": source, "use": use, "created": ts(), "url": None, "reflib": True})


def run_reflib_scan(jid):
    job = STATE["jobs"][jid]
    st = S()
    new = reflib_unscanned()
    ws = ws_client()
    pin, pout = llm_price("llm_review", st["llm_review"])
    tagged, cost_total = 0, 0.0
    for path, source in new:
        label, use = path.stem.replace("_", " ").replace("-", " "), "other"
        try:
            url = ws.upload_local(path)
            content, usage = ws.chat(st["llm_review"], REFLIB_TAG_SYS, "Tag this image.", True, images=[url])
            d = parse_json(content)
            label = str(d.get("label") or label)[:80]
            if d.get("use") in COMPONENT_USES:
                use = d["use"]
            pt = usage.get("prompt_tokens") or 200
            ct = usage.get("completion_tokens") or 30
            cost_total += pt / 1e6 * pin + ct / 1e6 * pout
        except ApiError as e:
            if e.code in (400, 422):
                with LOCK:
                    STATE["llm_vision_ok"] = False
            log(f"Không gắn nhãn được {path.name} bằng LLM ({e}) — dùng tên file làm nhãn.")
        if source == "real" and use in ("face", "eyes"):
            use = "other"  # hard rule: never auto-tag a real photo as face/eyes
        with LOCK:
            STATE["reflib"]["scanned"][reflib_key(path)] = {"label": label, "source": source, "use": use, "t": ts()}
        tagged += 1
        save()
    with LOCK:
        job.update(cost=round(cost_total, 5), status="done", t_end=ts(), result=f"Đã quét {tagged} ảnh mới.")
    save()
    ledger(job, "xong", cost_total)
    log(f"Quét kho ref: {tagged} ảnh mới")


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
        f = _find_fix(t)
        return asset_dest("02_Production/frames", f"Fix_{slug(f['batch'])}_{f['start']}-{f['end']}s_v{v}{ext}")
    if k == "patch":
        f = _find_fix(t)
        ep, _ = batch_by_id(f["batch"])
        return asset_dest(f"02_Production/{ep['id']}", f"{proj_name()}_{ep['id']}_Video_{f['batch']}_patch_{f['start']}-{f['end']}s_v{v}{ext}")
    if k == "gen":
        ep, _ = batch_by_id(t)
        return asset_dest(f"02_Production/{ep['id']}", f"{proj_name()}_{ep['id']}_Video_{t}_v{v}{ext}")
    return OUT / "media" / k / f"{slug(t)}_t{v}{ext}"


def run_media(jid):
    with LOCK:
        job = STATE["jobs"][jid]
        resume = bool(job.get("pid"))
    if not resume:
        body, prompt, extra = build_body(job)  # may hit the network (uploads, chat/template rewrite) — no LOCK held
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
            job["file"] = str(dest.relative_to(DATA_DIR))
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


def apply_measured_price(bid, model, per_unit):
    """Use the real measured price from now on; if 2.5 measures above $0.16/s, warn and switch any
    not-yet-generated 2.5 batch (in the SAME episode) to 2.0 (owner can switch back by hand)."""
    with LOCK:
        ep, b = batch_by_id(bid)
        if b:
            b["price"] = per_unit
        if "seedance-2.5" in model and per_unit > PRICE_WARN_PER_S and ep:
            log(f"CẢNH BÁO: {model} đo được ${per_unit}/s, cao hơn $0.16/s dự kiến.")
            for other in ep["batches"]:
                if other["id"] == bid or live_takes("gen", other["id"]):
                    continue
                if "seedance-2.5" in other["model"]:
                    other["model"] = "bytedance/seedance-2.0/reference-to-video"
                    other["price"] = 0.09
                    log(f"Đã đổi {other['id']} sang Seedance 2.0 (giá 2.5 đo được cao). Đổi lại bằng tay nếu muốn.")
    save()


def run_job(jid):
    try:
        kind = STATE["jobs"][jid]["kind"]
        if kind == "video_edit":
            run_video_edit(jid)
        elif kind in LLM_KINDS:
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


# ---------------------------------------------------------------- fixes (Sửa đoạn hỏng, per batch)
def new_fix(bid, start, end):
    ep, b = batch_by_id(bid)
    if not b:
        raise ValueError("batch không hợp lệ.")
    start, end = int(start), int(end)
    if end - start < 4:
        end = start + 4
    if end - start > 10:
        end = start + 10
    clip = pick("gen", bid)
    if not clip or not clip.get("file"):
        raise ValueError(f"{bid}: chưa có clip trên máy để cắt khung hình.")
    ff = shutil.which("ffmpeg")
    if not ff:
        raise ValueError("Máy chưa có ffmpeg — cài rồi thử lại (winget install Gyan.FFmpeg).")
    fid = f"fix_{sum(len(e['fixes']) for e in STATE['episodes'].values()) + 1}"
    frame_path = OUT / "media" / "frame" / f"{fid}.jpg"
    frame_path.parent.mkdir(parents=True, exist_ok=True)
    r = subprocess.run([ff, "-y", "-v", "error", "-ss", str(start), "-i", str(DATA_DIR / clip["file"]),
                        "-frames:v", "1", str(frame_path)], capture_output=True, text=True, errors="replace")
    if r.returncode != 0:
        raise ValueError("ffmpeg lỗi khi cắt khung hình: " + r.stderr[-300:])
    ep["fixes"][fid] = {"id": fid, "batch": bid, "start": start, "end": end, "prompt": "", "created": ts()}
    save()
    register_local("frame", fid, frame_path)
    return ep["fixes"][fid]


# ---------------------------------------------------------------- export (spec §5.7, per episode)
def do_export(eid):
    ep = episode(eid)
    proj = proj_name()
    dst = EXPORT_DIR / eid
    dst.mkdir(parents=True, exist_ok=True)
    lines, files = [], []
    order = [b["id"] for b in ep["batches"]]
    for bid in order:
        j = pick("gen", bid)
        if j and j.get("file"):
            name = Path(j["file"]).name
            shutil.copy2(DATA_DIR / j["file"], dst / name)
            b = next(x for x in ep["batches"] if x["id"] == bid)
            lines.append(f"{bid}\t{name}\t0-{b['duration']}s")
            files.append(name)
    for fid, f in ep["fixes"].items():
        j = pick("patch", fid)
        if j and j.get("file"):
            name = Path(j["file"]).name
            shutil.copy2(DATA_DIR / j["file"], dst / name)
            lines.append(f"{f['batch']} patch\t{name}\t{f['start']}-{f['end']}s")
            files.append(name)
    (dst / "danh_sach.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    ff = shutil.which("ffmpeg")
    joined = None
    if ff:
        clips = [pick("gen", b) for b in order if pick("gen", b) and pick("gen", b).get("file")]
        if clips and len(clips) == len(order):
            listfile = dst / "list.txt"
            listfile.write_text("".join(f"file '{Path(c['file']).name}'\n" for c in clips), encoding="utf-8")
            out = dst / f"{proj}_{eid}_full.mp4"
            r = subprocess.run([ff, "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", str(listfile),
                                "-c", "copy", str(out)], capture_output=True, text=True, errors="replace", cwd=dst)
            if r.returncode == 0:
                joined = out.name
    with LOCK:
        ep["export"] = {"status": "done", "dir": str(dst.relative_to(DATA_DIR)), "n": len(lines), "t": ts(),
                        "joined": joined, "files": files}
    save()
    log(f"Đã xuất {len(lines)} file vào {dst}")


# ---------------------------------------------------------------- cost / projection / public state
def cost_summary():
    spent, reserved = money()
    real = None
    for p in ("wavespeed", "atlas", "eachlabs"):
        b = STATE["balance"].get(p, {})
        if b.get("start") is not None and b.get("now") is not None:
            real = (real or 0) + b["start"] - b["now"]
    series_spent = round(sum(j.get("cost", 0) for j in STATE["jobs"].values()
                              if j["kind"] in SERIES_KINDS and (j["status"] in ("done", "stalled") or (j["status"] == "failed" and j.get("cost", 0) > 0))), 4)
    episode_spent = round(spent - series_spent, 4)
    basis = real if real is not None else spent
    basis_episode = max(0.0, basis - series_spent)
    projection = round((basis_episode * N_EPISODES + series_spent) * VND_PER_USD)
    return {"spent": spent, "reserved": reserved, "real": real, "series_spent": series_spent,
            "episode_spent": episode_spent, "projection_vnd": projection, "target_vnd": TARGET_VND,
            "contract_vnd": CONTRACT_VND, "cap_usd": budget()}


def mapping_preview(bid):
    try:
        m = build_mapping(bid)
        return m["text"]
    except Exception as e:
        return "(chưa đủ dữ liệu để dựng tham chiếu: " + str(e) + ")"


def public_state():
    with LOCK:
        jobs = [{k: j.get(k) for k in ("id", "kind", "target", "take", "status", "model", "est", "cost", "error",
                                        "file", "url", "last_frame", "created", "label", "tokens", "units",
                                        "unit_price", "prompt", "dl_error", "result", "provider", "measure", "measured",
                                        "dur", "edit", "resolution", "knowledge_used", "base_take", "edit_prompt", "mode", "cost_unknown", "skill", "task_id")}
                for j in sorted(STATE["jobs"].values(), key=lambda j: j["n"])]
        todo = {}
        for stage in ("split_episodes", "parse_list", "preprod", "reflib_scan", "portrait", "sheet", "env_wide", "env_rev", "prop", "prompt", "review", "gen"):
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
            if j["status"] in ("done", "stalled") or (j["status"] == "running" and j.get("pid")) or (j["status"] == "failed" and j.get("cost", 0) > 0):
                b["spent"] = round(b["spent"] + j.get("cost", 0), 4)
        mapping = {}
        for ep in STATE["episodes"].values():
            for b in ep["batches"]:
                mapping[b["id"]] = mapping_preview(b["id"])
        kb_docs, kb_conflicts = public_knowledge()
        return {"token_ok": True, "project": STATE["project"], "script_raw": STATE["script_raw"],
                "list_raw": STATE["list_raw"], "style": STATE["style"], "templates": STATE["templates"],
                "reflib": {"path": STATE["reflib"]["path"], "n_scanned": len(STATE["reflib"]["scanned"]),
                          "n_unscanned": len(reflib_unscanned()) if STATE["reflib"]["path"] else 0},
                "episodes": STATE["episodes"], "episodes_order": STATE["episodes_order"],
                "chars": STATE["chars"], "envs": STATE["envs"], "props": STATE["props"], "voices": STATE["voices"],
                "video_refs": STATE["video_refs"], "settings": STATE["settings"],
                "chats": STATE["chats"], "llm_vision_ok": STATE.get("llm_vision_ok", True),
                "jobs": jobs, "picks": STATE["picks"], "todo": todo, "by_stage": by_stage, "budget": budget(),
                "keys": {p: bool(KEYS.get(k)) for p, k in KEY_OF.items()},
                "key_preview": {p: mask_key(KEYS.get(k)) for p, k in KEY_OF.items()},
                "data_dir": str(DATA_DIR), "money": {"spent": money()[0], "reserved": money()[1]},
                "balance": STATE["balance"], "cost": cost_summary(), "component_uses": COMPONENT_USES,
                "ffmpeg": bool(shutil.which("ffmpeg")), "tier_name": TIER_NAME,
                "running": len(RUNNING), "stage_names": STAGE_NAME,
                "series_kinds": sorted(SERIES_KINDS), "mapping": mapping, "model_catalog": full_model_catalog(),
                "knowledge": kb_docs, "knowledge_conflicts": kb_conflicts, "slots": SLOTS, "slot_name": SLOT_NAME,
                "condense_word_threshold": CONDENSE_WORD_THRESHOLD, "dialogue_wps": DIALOGUE_WPS,
                "video_editing_skill": video_editing_skill_status()}
