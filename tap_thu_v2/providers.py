"""Gọi API — WaveSpeed (ảnh, LLM, upload, số dư) và Atlas Cloud (video Seedance, số dư).
Không có logic nghiệp vụ ở đây; pipeline.py quyết định gọi gì, khi nào, với body gì.
"""
import json
import mimetypes
import shutil
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse


class ApiError(Exception):
    def __init__(self, msg, code=None):
        super().__init__(msg)
        self.code = code


def http(method, url, key, body=None, timeout=120, raw=None, ctype=None):
    """One API call. JSON body, or raw bytes (for uploads). Retried only on 429 / GET 5xx."""
    data = raw if raw is not None else (json.dumps(body).encode("utf-8") if body is not None else None)
    host = urlparse(url).netloc
    for attempt in range(4):
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", "Bearer " + key)
        req.add_header("User-Agent", "ktoonstudio-tapthu-v2/1.0")
        req.add_header("Accept", "application/json")
        if raw is not None:
            req.add_header("Content-Type", ctype or "application/octet-stream")
        elif data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                out = r.read()
            try:
                return json.loads(out.decode("utf-8")) if out else {}
            except ValueError:
                raise ApiError(f"{host} trả về dữ liệu không đọc được: {out[:120]!r}")
        except urllib.error.HTTPError as e:
            msg = e.read().decode("utf-8", "replace")[:600]
            retry = e.code == 429 or (method == "GET" and e.code >= 500)
            if retry and attempt < 3:
                time.sleep(4 * (attempt + 1))
                continue
            if e.code in (401, 403):
                raise ApiError(f"{host} từ chối key (HTTP {e.code}). Kiểm tra key trong keys.txt. {msg[:200]}", e.code)
            if e.code == 402:
                raise ApiError(f"{host} báo hết tiền (HTTP 402). Nạp thêm rồi chạy lại.", e.code)
            raise ApiError(f"{host} báo lỗi HTTP {e.code}: {msg}", e.code)
        except (urllib.error.URLError, OSError) as e:
            if method == "GET" and attempt < 3:
                time.sleep(4 * (attempt + 1))
                continue
            raise ApiError(f"Không kết nối được {host}: {getattr(e, 'reason', e)}")
    raise ApiError(f"{host} không trả lời sau nhiều lần thử")


def download(url, dest):
    req = urllib.request.Request(url, headers={"User-Agent": "ktoonstudio-tapthu-v2/1.0"})
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".part")
    with urllib.request.urlopen(req, timeout=300) as r, open(tmp, "wb") as f:
        shutil.copyfileobj(r, f, 1 << 16)
    import os
    os.replace(tmp, dest)


def ext_for(url):
    path = urlparse(url).path.lower()
    for e in (".jpg", ".jpeg", ".png", ".webp", ".mp4", ".mov", ".webm", ".mp3", ".wav"):
        if path.endswith(e):
            return ".jpg" if e == ".jpeg" else e
    return ".bin"


# ---------------------------------------------------------------- WaveSpeed
class WaveSpeed:
    def __init__(self, base, llm_base, key):
        self.base, self.llm_base, self.key = base, llm_base, key

    def submit_media(self, model, body):
        r = http("POST", f"{self.base}/{model}", self.key, body)
        d = r.get("data") or r
        pid = d.get("id")
        if not pid:
            raise ApiError("WaveSpeed không trả về mã việc: " + json.dumps(r, ensure_ascii=False)[:300])
        return pid

    def result(self, pid):
        d = http("GET", f"{self.base}/predictions/{pid}/result", self.key)
        d = d.get("data") or d
        st = str(d.get("status") or "").lower()
        if st in ("completed", "succeeded", "success"):
            outs = d.get("outputs") or []
            if not outs:
                return "failed", "Báo xong nhưng không có file.", None
            out = outs[0]
            if isinstance(out, dict):
                out = out.get("url") or out.get("uri") or ""
            return "done", out, None
        if st in ("failed", "error", "canceled", "cancelled"):
            return "failed", d.get("error") or st, None
        return "running", None, None

    def upload_local(self, path):
        """Upload one local file, return its public URL (used as a reference for both WaveSpeed and Atlas)."""
        p = Path(path)
        ctype = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
        r = http("POST", f"{self.base}/media/upload/binary", self.key, raw=p.read_bytes(), ctype=ctype, timeout=180)
        d = r.get("data") or r
        url = d.get("url") or d.get("download_url") or r.get("url")
        if not url:
            raise ApiError("WaveSpeed upload không trả về url: " + json.dumps(r, ensure_ascii=False)[:300])
        return url

    def balance(self):
        r = http("GET", f"{self.base}/balance", self.key, timeout=30)
        return float((r.get("data") or {}).get("balance"))

    def chat(self, model, system, user, json_mode, images=None, reasoning=None):
        user_content = user
        if images:
            # OpenAI-style content parts. Open item (spec §12): unverified whether the WaveSpeed LLM accepts these.
            user_content = [{"type": "text", "text": user}] + [{"type": "image_url", "image_url": {"url": u}} for u in images]
        body = {"model": model, "messages": [{"role": "system", "content": system}, {"role": "user", "content": user_content}]}
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        if reasoning:
            # OpenAI Chat Completions "reasoning_effort" convention (low|medium|high). Open item (spec §16):
            # unverified whether WaveSpeed forwards this the same way for every underlying model (e.g. Claude).
            body["reasoning_effort"] = reasoning
        try:
            r = http("POST", f"{self.llm_base}/chat/completions", self.key, body, timeout=900)
        except ApiError as e:
            if json_mode and e.code in (400, 422):
                body.pop("response_format", None)
                r = http("POST", f"{self.llm_base}/chat/completions", self.key, body, timeout=900)
            else:
                raise
        choice = (r.get("choices") or [{}])[0]
        content = (choice.get("message") or {}).get("content")
        if isinstance(content, list):
            content = "".join(c.get("text", "") for c in content if isinstance(c, dict))
        if not content:
            raise ApiError("Model trả về rỗng" + (f" (finish_reason={choice.get('finish_reason')})" if choice.get("finish_reason") else ""))
        return content.strip(), r.get("usage") or {}


# ---------------------------------------------------------------- Atlas Cloud
class Atlas:
    def __init__(self, base, pub_base, key):
        self.base, self.pub_base, self.key = base, pub_base, key

    def submit_video(self, model, body):
        body = dict(body, model=model)
        r = http("POST", f"{self.base}/generateVideo", self.key, body)
        d = r.get("data") or r
        pid = d.get("id") or d.get("prediction_id")
        if not pid:
            raise ApiError("Atlas không trả về mã việc: " + json.dumps(r, ensure_ascii=False)[:300])
        return pid

    def result(self, pid):
        d = http("GET", f"{self.base}/prediction/{pid}", self.key)
        d = d.get("data") or d
        st = str(d.get("status") or "").lower()
        if st in ("completed", "succeeded", "success"):
            outs = d.get("outputs") or []
            if not outs:
                return "failed", "Báo xong nhưng không có file.", None
            out = outs[0]
            if isinstance(out, dict):
                out = out.get("url") or out.get("uri") or ""
            last_frame = d.get("last_frame") or d.get("last_frame_url") or d.get("return_last_frame")
            if not last_frame and len(outs) > 1:
                o1 = outs[1]
                last_frame = o1.get("url") if isinstance(o1, dict) else o1
            return "done", out, last_frame
        if st in ("failed", "error", "canceled", "cancelled"):
            return "failed", d.get("error") or st, None
        return "running", None, None

    def balance(self):
        r = http("GET", f"{self.pub_base}/balance", self.key, timeout=30)
        return float((r.get("available") or {}).get("value"))
