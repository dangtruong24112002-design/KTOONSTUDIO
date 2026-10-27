"""Explicit provider adapters and dated public tariffs. Standard library only.

No paid POST is retried. Catalog prices/usage calculations are not invoices.
The host app is passed explicitly so adapters can be exercised without keys or data.
"""
import base64
import json
import math
import re
import time
import urllib.error
import urllib.request
from urllib.parse import urlparse

CHECKED = "2026-10-05"
GOOGLE = "https://generativelanguage.googleapis.com/v1beta"
XAI = "https://api.x.ai/v1"
DEEPSEEK = "https://api.deepseek.com"
DP = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/"
GP = "https://ai.google.dev/gemini-api/docs/pricing"
XP = "https://docs.x.ai/developers/pricing"
PROVIDERS = {
    "wavespeed": {"name": "WaveSpeed", "key": "WAVESPEED_API_KEY", "console": "https://wavespeed.ai/accesskey"},
    "atlas": {"name": "Atlas Cloud", "key": "ATLASCLOUD_API_KEY", "console": "https://www.atlascloud.ai/console"},
    "xai": {"name": "xAI · Grok", "key": "XAI_API_KEY", "console": "https://console.x.ai/"},
    "google": {"name": "Google Gemini API · Nano / Veo", "key": "GEMINI_API_KEY", "console": "https://aistudio.google.com/apikey"},
    "deepseek": {"name": "DeepSeek", "key": "DEEPSEEK_API_KEY", "console": "https://platform.deepseek.com/api_keys"},
}


def catalog():
    llm = [
        {"id": "xai/grok-4.7", "api_model": "grok-4.7", "label": "Grok 4.7 · xAI", "in": 2.0, "out": 6.0, "cached": 0.5,
         "context": 500000, "efforts": ["low", "medium", "high", "xhigh"], "long_in": 4.0, "long_out": 12.0, "long_cached": 1.0},
        {"id": "xai/grok-4.3", "api_model": "grok-4.3", "label": "Grok 4.3 · xAI · economical", "in": 1.25, "out": 2.5, "cached": 0.2,
         "context": 1000000, "efforts": [], "long_in": 2.5, "long_out": 5.0, "long_cached": 0.4},
        {"id": "xai/grok-4.20-0309-non-reasoning", "api_model": "grok-4.20-0309-non-reasoning", "label": "Grok 4.20 · xAI · non-reasoning", "in": 1.25, "out": 2.5, "cached": 0.2,
         "context": 1000000, "efforts": [], "long_in": 2.5, "long_out": 5.0, "long_cached": 0.4},
    ]
    for m in llm:
        m.update(provider="xai", adapter="xai_llm", price_source=XP, price_checked=CHECKED, long_threshold=200000,
                 price_note="USD / 1M tokens; input ≥200k uses long-context rates for the whole request. Cached input has a separate rate. Reasoning is included in output tokens.",
                 use_case="Write and edit scripts, develop characters, shotlists, prompts; uses the master instruction attached to the node.")
    # DeepSeek (OpenAI-compatible chat/completions). Peak-hour USD list prices, checked 2026-10-16; off-peak is half (billed by DeepSeek, not estimated here).
    ds = [
        {"id": "deepseek/deepseek-flash", "api_model": "deepseek-flash", "label": "DeepSeek V4.1 Flash · cheap, script writing", "in": 0.30, "out": 1.20, "cached": 0.006},
        {"id": "deepseek/deepseek-v4-pro", "api_model": "deepseek-v4-pro", "label": "DeepSeek V4 Pro", "in": 1.32, "out": 3.96, "cached": 0.044},
    ]
    for m in ds:
        m.update(provider="deepseek", adapter="xai_llm", price_source=DP, price_checked="2026-10-16", context=1000000, efforts=[], vision=False, default_max_tokens=32000,
                 price_note="USD / 1M tokens at DeepSeek peak hours (09:00–12:00, 14:00–18:00 Beijing time, Mon–Fri); off-peak is half. Cached input has a separate rate. Text only (no image input).",
                 use_case="Write and edit scripts, outlines, shotlists, video prompts — low cost; uses the master instruction attached to the node.")
    llm += ds
    image = []
    for mid, label, prices, inp, txt, out in [
        ("gemini-3.1-flash-image", "Nano Banana 2", {"1k": .067, "2k": .101, "4k": .151}, .5, 3, 60),
        ("gemini-3-pro-image", "Nano Banana Pro", {"1k": .134, "2k": .134, "4k": .24}, 2, 12, 120),
        ("gemini-3.1-flash-lite-image", "Nano Banana 2 Lite", {"1k": .0336}, .25, 1.5, 30),
    ]:
        image.append({"id": "google-direct/"+mid, "api_model": mid, "label": label+" · Google API", "provider": "google", "adapter": "google_image",
                      "max_refs": 14, "res": list(prices), "prices": prices, "price": min(prices.values()), "input_rate": inp, "text_rate": txt, "image_rate": out,
                      "price_source": GP, "price_checked": CHECKED, "price_note": "Image output equivalent by resolution, plus input/text/thinking tokens. Standard API rates; Flow subscription credits do not apply.",
                      "use_case": "Character / location design, character sheets, image edits from up to 14 reference images."})
    image.append({"id": "ws/flux-2-pro", "label": "FLUX.2 Pro · WaveSpeed", "provider": "wavespeed", "adapter": "ws_flux",
                  "t2i": "wavespeed-ai/flux-2-pro/text-to-image", "edit": "wavespeed-ai/flux-2-pro/edit", "max_refs": 3,
                  "res": ["1k"], "price": .03, "edit_price": .06,
                  "price_source": "https://wavespeed.ai/docs/docs-api/wavespeed-ai/flux-2-pro-text-to-image",
                  "edit_price_source": "https://wavespeed.ai/docs/docs-api/wavespeed-ai/flux-2-pro-edit", "price_checked": CHECKED,
                  "price_note": "$0.03 text-to-image; $0.06 with reference images. Edit endpoint chooses output dimensions; it has no resolution/aspect parameter.",
                  "use_case": "Concept art, keyframes and image edits with up to 3 input images."})
    video = []
    for suffix, label, prices, refs in [
        ("generate-preview", "Veo 3.1 Standard", {"720p": .40, "1080p": .40, "4k": .60}, 3),
        ("fast-generate-preview", "Veo 3.1 Fast", {"720p": .10, "1080p": .12, "4k": .30}, 3),
        ("lite-generate-preview", "Veo 3.1 Lite", {"720p": .05, "1080p": .08}, 0),
    ]:
        mid = "veo-3.1-"+suffix
        video.append({"id": "google-direct/"+mid, "api_model": mid, "label": label+" · Google API", "provider": "google", "adapter": "google_veo", "mode": "flex",
                      "max_s": 8, "min_s": 4, "durations": [4, 6, 8], "max_refs": max(1, refs), "asset_refs": refs, "max_vid": 0, "max_aud": 0,
                      "vres": list(prices), "ratios": ["9:16", "16:9"], "video_prices": prices, "price": min(prices.values()),
                      "price_source": GP, "price_checked": CHECKED, "price_note": "USD / generated second, native audio included. 1080p/4K and asset references require 8 seconds. Flow credits are separate.",
                      "use_case": "Scenes with audio, text-to-video or animate a first frame"+("; up to 3 reference images in References mode." if refs else ".")})
    for mode in ("t2v", "i2v"):
        endpoint = "text-to-video" if mode == "t2v" else "image-to-video"
        mid = "kwaivgi/kling-v3.0-pro/"+endpoint
        video.append({"id": "ws/"+mid, "api_model": mid, "label": "Kling 3.0 Pro · "+endpoint+" · WaveSpeed", "provider": "wavespeed", "adapter": "ws_kling", "mode": mode,
                      "max_s": 15, "min_s": 3, "max_refs": 1 if mode == "i2v" else 0, "max_vid": 0, "max_aud": 0,
                      "vres": ["native"], "ratios": ["9:16", "16:9", "1:1"], "price": .168, "silent_price": .112,
                      "price_source": "https://wavespeed.ai/docs/docs-api/kwaivgi/kwaivgi-kling-v3.0-pro-"+endpoint, "price_checked": CHECKED,
                      "price_note": "$0.168/s with sound; $0.112/s without sound. 3–15 seconds. Pro output resolution is provider-controlled.",
                      "use_case": "Acting / camera movement; one first-frame image for image-to-video."})
    audio = [{"id": "wavespeed/elevenlabs/music-v2.5", "api_model": "elevenlabs/music-v2.5",
              "label": "ElevenLabs Music v2.5 · WaveSpeed", "provider": "wavespeed", "adapter": "ws_music",
              "min_s": 3, "max_s": 600, "price_per_started_minute": .75,
              "price_source": "https://wavespeed.ai/docs/docs-api/elevenlabs/elevenlabs-music-v2.5",
              "price_checked": "2026-10-26",
              "price_note": "$0.75 per started minute (minimum $0.75 per request); instrumental MP3. Requested duration is billed.",
              "use_case": "Story-aware instrumental score for an episode or scene, 3–600 seconds."}]
    return {"llm": llm, "image": image, "video": video, "audio": audio}


def install(target, keys):
    for p in ("xai", "google", "deepseek"):
        keys[p] = PROVIDERS[p]["key"]
    for kind, rows in target.items():
        for m in rows:
            m.setdefault("provider", "atlas" if kind == "video" else "wavespeed")
            m.setdefault("price_note", "Legacy estimate from the existing installation; not reverified in this update.")
        rows.extend(catalog()[kind])


def extra(a, req, m):
    raw = req.get("extra") or {}
    # Older Story Studio clients used this field to tag their prompt role.
    # It is metadata, not provider parameters; accept it for compatibility.
    if isinstance(raw, str) and re.fullmatch(r"role:[a-z0-9_]+", raw.strip(), re.I):
        raw = {}
    try:
        obj = json.loads(raw) if isinstance(raw, str) else raw
    except (ValueError, TypeError):
        raise a.ApiError("Advanced parameters must be valid JSON.")
    allowed = {"xai_llm": {"temperature", "top_p", "max_tokens"}, "google_image": set(), "google_veo": {"seed", "negativePrompt"},
               "ws_flux": {"seed"}, "ws_kling": {"negative_prompt", "cfg_scale"}, "ws_music": set()}[m["adapter"]]
    if not isinstance(obj, dict) or set(obj)-allowed:
        raise a.ApiError("Unsupported Advanced parameters for this model. Allowed: "+(", ".join(sorted(allowed)) or "none")+". Model, references and priced settings must use the node controls.")
    if "max_tokens" in obj and not 1 <= integer(a, obj["max_tokens"], "max_tokens") <= 100000:
        raise a.ApiError("max_tokens must be 1–100000.")
    return obj


def integer(a, value, label):
    try:
        n = float(value)
        if not math.isfinite(n) or n != int(n): raise ValueError()
        return int(n)
    except (ValueError, TypeError, OverflowError):
        raise a.ApiError(label+" must be an integer.")


def validate(a, req, m):
    extra(a, req, m)
    images, videos, audios = [req.get(k) or [] for k in ("images", "videos", "audios")]
    if videos or audios:
        raise a.ApiError("BLOCKED_REFERENCE_LIMIT: this adapter does not accept video/audio references. No input was dropped.")
    if m["adapter"] == "xai_llm":
        if m.get("vision") is False and (images or any(x.get("images") for x in req.get("messages") or [])):
            raise a.ApiError(f"BLOCKED_REFERENCE_LIMIT: {m['label']} accepts text only — unlink the images from this LLM node or choose another model. No image is dropped silently.")
        return
    if m["adapter"] in ("google_image", "ws_flux"):
        if len(images) > m["max_refs"]:
            raise a.ApiError(f"BLOCKED_REFERENCE_LIMIT: {m['label']} accepts {m['max_refs']} images; connected {len(images)}. No image was dropped.")
        if req.get("res", "1k") not in m["res"]:
            raise a.ApiError("UNSUPPORTED_CONFIGURATION: choose image resolution "+" / ".join(m["res"]))
        if not 1 <= integer(a, req.get("count") or 1, "Image count") <= 4:
            raise a.ApiError("Image count must be 1–4.")
        if req.get("aspect", "9:16") not in ("9:16", "3:4", "1:1", "4:3", "16:9", "21:9"):
            raise a.ApiError("Unsupported aspect ratio.")
        return
    if m["adapter"] == "ws_music":
        duration = integer(a, req.get("duration") or 0, "Music duration")
        if not 3 <= duration <= m["max_s"]:
            raise a.ApiError("UNSUPPORTED_CONFIGURATION: music duration must be 3–600 seconds.")
        text = prompt(req)
        if not text.strip() or len(text) > 4100:
            raise a.ApiError("Music prompt must contain 1–4100 characters.")
        if req.get("output_format", "mp3_48000_192") not in (
            "mp3_22050_32", "mp3_24000_48", "mp3_44100_32", "mp3_44100_64", "mp3_44100_96",
            "mp3_44100_128", "mp3_44100_192", "mp3_48000_128", "mp3_48000_192", "mp3_48000_240", "mp3_48000_320"):
            raise a.ApiError("Unsupported music output format.")
        return
    dur = integer(a, req.get("duration") or 0, "Duration")
    if not m["min_s"] <= dur <= m["max_s"] or (m.get("durations") and dur not in m["durations"]):
        raise a.ApiError("UNSUPPORTED_CONFIGURATION: "+m["label"]+" requires "+(" / ".join(map(str, m["durations"])) if m.get("durations") else f"{m['min_s']}–{m['max_s']}")+" seconds. Duration was not changed.")
    if req.get("resolution") not in m["vres"] or req.get("ratio") not in m["ratios"]:
        raise a.ApiError("UNSUPPORTED_CONFIGURATION: choose resolution "+" / ".join(m["vres"])+" and aspect ratio "+" / ".join(m["ratios"]))
    if m["adapter"] == "google_veo":
        mode = req.get("video_input") or "first_frame"
        if mode not in ("first_frame", "references"):
            raise a.ApiError("Choose First frame or References mode.")
        cap = m["asset_refs"] if mode == "references" else 1
        if mode == "references" and not cap:
            raise a.ApiError("This Veo model does not support asset reference images. Use First frame or Veo Standard/Fast.")
        if images and mode == "references" and dur != 8 or req.get("resolution") != "720p" and dur != 8:
            raise a.ApiError("Veo references / 1080p / 4K require exactly 8 seconds.")
    else:
        cap = m["max_refs"]
        if m["mode"] == "i2v" and not images:
            raise a.ApiError("Kling image-to-video needs one first-frame image.")
    if len(images) > cap:
        raise a.ApiError(f"BLOCKED_REFERENCE_LIMIT: this mode accepts {cap} image(s); connected {len(images)}. No image was dropped.")


def prompt(req):
    return "\n\n".join([str(t) for t in req.get("texts", []) if str(t).strip()] + ([str(req["prompt"])] if req.get("prompt", "").strip() else []))


def token_cost(m, inputs, outputs, cached=0):
    prefix = "long_" if inputs >= m.get("long_threshold", math.inf) else ""
    cached = max(0, min(inputs, cached))
    return ((inputs-cached)*m[prefix+"in"] + cached*m.get(prefix+"cached", m[prefix+"in"]) + outputs*m[prefix+"out"])/1e6


def estimate(a, req, m):
    validate(a, req, m)
    if m["adapter"] == "xai_llm":
        chars = len(prompt(req))+len(req.get("system") or "")+sum(len(str(x.get("content") or "")) for x in req.get("messages") or [])
        nimg = len(req.get("images") or [])+sum(len(x.get("images") or []) for x in req.get("messages") or [])
        out = int(extra(a, req, m).get("max_tokens") or 6000)
        return round(token_cost(m, math.ceil(chars/3.5)+1100*nimg, out)*(2 if req.get("review") else 1), 6)
    if m["adapter"] == "google_image":
        inp = math.ceil(len(prompt(req))/3.5)+1120*len(req.get("images") or [])
        return round((m["prices"][req.get("res") or "1k"]+(inp*m["input_rate"]+2048*m["text_rate"])/1e6)*int(req.get("count") or 1), 6)
    if m["adapter"] == "ws_flux":
        return round((m["edit_price"] if req.get("images") else m["price"])*int(req.get("count") or 1), 6)
    if m["adapter"] == "ws_music":
        return round(m["price_per_started_minute"] * math.ceil(int(req["duration"]) / 60), 6)
    rate = m["video_prices"][req["resolution"]] if m["adapter"] == "google_veo" else m["price"] if req.get("sound", True) else m["silent_price"]
    return round(rate*int(req["duration"]), 6)


def call(a, provider, method, route, body=None, timeout=60):
    """Exactly one transport attempt, including submit errors. GET polling can be resumed."""
    base = {"xai": XAI, "google": GOOGLE, "deepseek": DEEPSEEK, "wavespeed": a.WS}[provider]
    if not re.fullmatch(r"[A-Za-z0-9_./:\-]+", route) or ".." in route:
        raise a.ApiError("Invalid provider operation path.")
    key = a.key_for(provider)
    headers = {"Content-Type": "application/json", "Accept": "application/json", "User-Agent": "ktoonstudio/4.2"}
    headers["x-goog-api-key" if provider == "google" else "Authorization"] = key if provider == "google" else "Bearer "+key
    rq = urllib.request.Request(base+"/"+route.lstrip("/"), data=json.dumps(body).encode("utf-8") if body is not None else None, headers=headers, method=method)
    try:
        with urllib.request.urlopen(rq, timeout=timeout) as r:
            result = json.loads(r.read().decode("utf-8"))
        if not isinstance(result, dict): raise ValueError("invalid response type")
        return result
    except urllib.error.HTTPError as e:
        detail = a.scrub(e.read().decode("utf-8", "replace"))[:450]
        prefix = "LLM_NO_RETRY: " if provider in ("xai", "deepseek") else ""
        raise a.ApiError(f"{prefix}{PROVIDERS[provider]['name']} HTTP {e.code}: {detail}. No request was sent again.", e.code)
    except (OSError, ValueError) as e:
        prefix = ("LLM_NO_RETRY: " if provider in ("xai", "deepseek") else "")+("UNKNOWN_SUBMISSION: " if method == "POST" else "POLL_INTERRUPTED: ")
        raise a.ApiError(prefix+PROVIDERS[provider]["name"]+" response unavailable: "+a.scrub(e)[:220]+". No request was sent again; check the provider dashboard.")


def mark(a, job, **values):
    with a.LOCK: job.update(values)
    a.save_jobs()


def submit(a, job, provider, route, body, timeout=120):
    mark(a, job, provider=provider, cost_basis="estimate", billing_unknown=True, retryable=False)
    try:
        return call(a, provider, "POST", route, body, timeout)
    except a.ApiError as e:
        # A definite client rejection is not an uncertain execution. Never infer refunds from timeouts/5xx.
        if e.code and 400 <= e.code < 500:
            mark(a, job, billing_unknown=False)
        raise


def llm_messages(a, req):
    msgs = []
    if req.get("system", "").strip(): msgs.append({"role": "system", "content": req["system"]})
    items = req.get("messages") or [{"role": "user", "content": prompt(req), "images": req.get("images") or []}]
    for item in items:
        role = item.get("role") or "user"
        if role not in ("user", "assistant", "system"): raise a.ApiError("Unsupported message role.")
        text = str(item.get("content") or "")
        ims = item.get("images") or []
        parts = [{"type": "text", "text": text}]+[{"type": "image_url", "image_url": {"url": a.media_ref_to_url(x)}} for x in ims]
        msgs.append({"role": role, "content": parts if ims else text})
    return msgs


def run_llm(a, job, req, m):
    validate(a, req, m)
    prov = m.get("provider") or "xai"
    pname = "DeepSeek" if prov == "deepseek" else "Grok"
    a.key_for(prov)
    sources = []
    if req.get("web"):
        try:
            ctx, sources = a.web_context(job, req)
        except Exception as e:
            ctx = ""
            job["warn"] = "Web lookup unavailable: "+a.scrub(e)[:150]
        req = dict(req, system=(req.get("system") or "")+("\n\n"+ctx if ctx else ""))
    msgs = llm_messages(a, req)
    if not any(x["role"] == "user" and x["content"] for x in msgs): raise a.ApiError("No LLM request content.")
    body = {"model": m["api_model"], "messages": msgs, "stream": False}
    body.update(extra(a, req, m))
    if m.get("default_max_tokens") and "max_tokens" not in body: body["max_tokens"] = m["default_max_tokens"]
    if req.get("json_mode"): body["response_format"] = {"type": "json_object"}
    effort = req.get("effort")
    if m["efforts"] and effort:
        mapped = {"none": "low", "max": "xhigh"}.get(effort, effort)
        if mapped not in m["efforts"]: raise a.ApiError("Unsupported Grok reasoning effort.")
        body["reasoning_effort"] = mapped
        if mapped != effort: job["warn"] = "Grok uses Thinking "+mapped+" for this request; the saved node setting is unchanged."
    timeout = max(30, min(900, float(req.get("llm_timeout_s") or 900)))
    mark(a, job, pid="llm", llm_timeout_s=timeout, llm_transport="standard", llm_effort=body.get("reasoning_effort") or "model default", phase=f"Waiting for {pname} response (non-streaming)")
    total, tokens = float(job.get("cost") or 0), [0, 0, 0]
    def attempt(b):
        nonlocal total
        mark(a, job, llm_attempts=job.get("llm_attempts", 0)+1)
        r = submit(a, job, prov, "chat/completions", b, timeout)
        ch = (r.get("choices") or [{}])[0]
        content = (ch.get("message") or {}).get("content")
        if isinstance(content, list): content = "".join(p.get("text", "") for p in content if isinstance(p, dict))
        u = r.get("usage") or {}
        pt = u.get("prompt_tokens")
        ct = u.get("completion_tokens")
        if pt is not None and ct is not None:
            cached = (u.get("prompt_tokens_details") or {}).get("cached_tokens") or 0
            total += token_cost(m, pt, ct, cached)
            rt = (u.get("completion_tokens_details") or {}).get("reasoning_tokens") or 0
            for i, value in enumerate((pt, ct, rt)): tokens[i] += value
            mark(a, job, cost=round(total, 6), cost_basis="usage_estimate", tokens=tokens[:], billing_unknown=False)
        else:
            total += estimate(a, dict(req, review=False), m)
            mark(a, job, cost=round(total, 6), cost_basis="estimate", billing_unknown=False,
                 warn="Provider returned no token usage; cost remains an estimate.")
        if ch.get("finish_reason") in ("length", "content_filter") or not content or not content.strip():
            if content: mark(a, job, partial_text=content)
            raise a.ApiError(f"LLM_NO_RETRY: {pname} returned incomplete/empty output. Any partial answer is kept in the job; no second request was sent.")
        return content.strip()
    content = attempt(body)
    if req.get("review"):
        review = dict(body, messages=msgs+[{"role": "assistant", "content": content}, {"role": "user", "content": "Review this draft against the original request and references. Return only the improved complete answer in the same format and language."}])
        try:
            content = attempt(review)
            job["reviewed"] = True
        except a.ApiError as e:
            job["warn"] = "Review failed; the first draft is retained. "+str(e)
            if job.get("billing_unknown"):
                mark(a, job, cost=round(total+estimate(a, dict(req, review=False), m), 6), cost_basis="unknown")
    mark(a, job, output={"text": content, "sources": sources, "steps": job.get("steps") or [], "reviewed": bool(job.get("reviewed"))})


def image_part(a, ref):
    data = a.media_ref_to_url(ref)
    if data.startswith("data:"):
        match = re.fullmatch(r"data:(image/(?:png|jpeg|webp));base64,(.+)", data, re.S)
        if not match: raise a.ApiError("Google image input must be PNG, JPEG or WebP.")
        return {"type": "image", "mime_type": match[1], "data": match[2]}
    if urlparse(data).scheme != "https": raise a.ApiError("Remote image references must use HTTPS.")
    return {"type": "image", "uri": data}


def save_image(a, job, part, index):
    mime = part.get("mime_type") or "image/png"
    ext = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}.get(mime)
    if not ext: raise a.ApiError("Unsupported generated image MIME type.")
    if part.get("data"):
        raw = base64.b64decode(part["data"], validate=True)
        dest = a.MEDIA / "image" / (job["id"]+"_"+str(index)+ext)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(raw)
        file = dest.relative_to(a.DATA).as_posix()
        wh = a.img_dims(dest)
        return dict({"file": file, "url": ""}, **({"w": wh[0], "h": wh[1]} if wh else {}))
    if part.get("uri"):
        file = a.download(part["uri"], "image", job["id"]+"_"+str(index))
        return {"file": file, "url": part["uri"]}
    raise a.ApiError("Google returned an image block without image data.")


def google_image_cost(m, response):
    u = response.get("usage") or {}
    details_in = u.get("input_tokens_by_modality") or []
    details_out = u.get("output_tokens_by_modality") or []
    # Only settle from an explicit image/text breakdown; otherwise keep the quoted estimate.
    if not details_out: return None
    inp = u.get("total_input_tokens")
    if inp is None: inp = sum(x.get("token_count", x.get("tokens", 0)) for x in details_in)
    image = sum(x.get("token_count", x.get("tokens", 0)) for x in details_out if str(x.get("modality")).lower() == "image")
    if not image: return None
    other = sum(x.get("token_count", x.get("tokens", 0)) for x in details_out if str(x.get("modality")).lower() != "image")
    other += u.get("total_thought_tokens") or 0
    return (inp*m["input_rate"]+image*m["image_rate"]+other*m["text_rate"])/1e6


def run_image(a, job, req, m):
    validate(a, req, m)
    a.key_for(m["provider"])
    text = prompt(req)
    if not text: raise a.ApiError("No image prompt.")
    if m["adapter"] == "ws_flux":
        return run_flux(a, job, req, m, text)
    parts = [{"type": "text", "text": text}]+[image_part(a, x) for x in req.get("images") or []]
    body = {"model": m["api_model"], "input": parts, "store": False, "stream": False, "service_tier": "standard", "response_format": {"type": "image", "mime_type": "image/png", "aspect_ratio": req.get("aspect") or "9:16", "image_size": (req.get("res") or "1k").upper()}}
    files, cost, exact = [], 0.0, True
    unit = estimate(a, dict(req, count=1), m)
    mark(a, job, provider="google", pid="sync-image", resume_adapter="sync", phase="Waiting for Nano Banana", cost=0)
    for i in range(int(req.get("count") or 1)):
        try:
            r = submit(a, job, "google", "interactions", body, 900)
            usage_cost = google_image_cost(m, r)
            cost += unit if usage_cost is None else usage_cost
            exact = exact and usage_cost is not None
            mark(a, job, cost=round(cost, 6), billing_unknown=False, cost_basis="usage_estimate" if exact else "estimate")
            blocks = [b for step in r.get("steps") or [] if step.get("type") == "model_output" for b in step.get("content") or [] if b.get("type") == "image" and not b.get("thought")]
            if not blocks and isinstance(r.get("output_image"), dict): blocks = [r["output_image"]]
            if not blocks: raise a.ApiError("Nano Banana returned no final image. Check the request or provider result; no request was sent again.")
            for b in blocks: files.append(save_image(a, job, b, len(files)))
            mark(a, job, output={"images": files[:]})
        except Exception as e:
            if job.get("billing_unknown"):
                mark(a, job, cost=round(cost+unit, 6), cost_basis="unknown")
            if not files: raise
            mark(a, job, warn="Some requested images are unavailable; completed images are retained. "+a.scrub(e)[:350])
            break


def run_flux(a, job, req, m, text):
    refs = [a.media_ref_to_url(x) for x in req.get("images") or []]
    route = m["edit"] if refs else m["t2i"]
    body = {"prompt": text, **extra(a, req, m)}
    if refs:
        body["images"] = refs
    else:
        w, h = map(int, (req.get("aspect") or "9:16").split(":"))
        scale = 1024/max(w, h)
        body["size"] = f"{round(w*scale/16)*16}*{round(h*scale/16)*16}"
    pids = []
    unit = m["edit_price"] if refs else m["price"]
    mark(a, job, provider="wavespeed", resume_adapter="ws", unit_cost=unit, pids=[], cost=0)
    for i in range(int(req.get("count") or 1)):
        try:
            r = submit(a, job, "wavespeed", route, body)
            d = r.get("data") or r
            pid = d.get("id")
            if not pid: raise a.ApiError("UNKNOWN_SUBMISSION: WaveSpeed returned no prediction ID. No request was sent again.")
            pids.append(pid)
            mark(a, job, pid=pids[0], pids=pids[:], cost=round(unit*len(pids), 6), billing_unknown=False)
        except Exception as e:
            if not pids: raise
            job["warn"] = "Some image submissions failed. "+a.scrub(e)[:300]
            break
    resume(a, job)


def veo_image(a, ref):
    p = image_part(a, ref)
    if p.get("data"): return {"inlineData": {"mimeType": p["mime_type"], "data": p["data"]}}
    # Veo's inline image contract differs from Interactions. Fetch public input bytes without credentials.
    with urllib.request.urlopen(urllib.request.Request(p["uri"], headers={"User-Agent": "ktoonstudio/4.2"}), timeout=60) as r:
        raw = r.read(20*1024*1024+1)
        mime = r.headers.get_content_type()
    if len(raw) > 20*1024*1024 or mime not in ("image/png", "image/jpeg", "image/webp"):
        raise a.ApiError("Unsupported or oversized Veo reference image (20 MiB max).")
    return {"inlineData": {"mimeType": mime, "data": base64.b64encode(raw).decode("ascii")}}


def run_video(a, job, req, m):
    validate(a, req, m)
    a.key_for(m["provider"])
    text = prompt(req)
    if not text: raise a.ApiError("No video prompt.")
    refs = req.get("images") or []
    quote = estimate(a, req, m)
    if m["adapter"] == "google_veo":
        instance = {"prompt": text}
        ims = [veo_image(a, x) for x in refs]
        if ims:
            if req.get("video_input") == "references":
                instance["referenceImages"] = [{"image": x, "referenceType": "asset"} for x in ims]
            else: instance["image"] = ims[0]
        params = {"aspectRatio": req["ratio"], "durationSeconds": int(req["duration"]), "resolution": req["resolution"], "numberOfVideos": 1, **extra(a, req, m)}
        mark(a, job, provider="google", resume_adapter="google_veo", cost=quote, dur=int(req["duration"]))
        r = submit(a, job, "google", "models/"+m["api_model"]+":predictLongRunning", {"instances": [instance], "parameters": params})
        pid = r.get("name")
        if not pid: raise a.ApiError("UNKNOWN_SUBMISSION: Google returned no operation ID. No second request was sent.")
        mark(a, job, pid=pid, billing_unknown=False, phase="Veo submitted · waiting")
    else:
        text = re.sub(r"@image1(?!\d)", "<<<image_1>>>", text, flags=re.I)
        body = {"prompt": text, "duration": int(req["duration"]), "sound": bool(req.get("sound", True)), **extra(a, req, m)}
        if refs: body["image"] = a.media_ref_to_url(refs[0])
        else: body["aspect_ratio"] = req["ratio"]
        mark(a, job, provider="wavespeed", resume_adapter="ws", cost=quote, dur=int(req["duration"]))
        r = submit(a, job, "wavespeed", m["api_model"], body)
        pid = (r.get("data") or r).get("id")
        if not pid: raise a.ApiError("UNKNOWN_SUBMISSION: WaveSpeed returned no prediction ID. No second request was sent.")
        mark(a, job, pid=pid, billing_unknown=False, phase="Kling submitted · waiting")
    resume(a, job)


def run_audio(a, job, req, m):
    validate(a, req, m)
    a.key_for("wavespeed")
    text = prompt(req)
    duration = int(req["duration"])
    quote = estimate(a, req, m)
    body = {"prompt": text, "music_length_ms": duration * 1000,
            "force_instrumental": bool(req.get("force_instrumental", True)),
            "output_format": req.get("output_format") or "mp3_48000_192"}
    mark(a, job, provider="wavespeed", resume_adapter="ws", unit_cost=quote,
         cost=quote, dur=duration, phase="Submitting instrumental soundtrack")
    r = submit(a, job, "wavespeed", m["api_model"], body, timeout=90)
    pid = (r.get("data") or r).get("id")
    if not pid:
        raise a.ApiError("UNKNOWN_SUBMISSION: WaveSpeed returned no prediction ID. No second request was sent.")
    mark(a, job, pid=pid, billing_unknown=False, phase="Music submitted · waiting")
    a.ledger(job, f"submitted instrumental soundtrack ({duration}s)", quote)
    resume(a, job)


class GoogleDownloadRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urlparse(newurl).scheme != "https": raise ValueError("Non-HTTPS Google media redirect")
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        # Signed CDN redirect does not need the API key; never forward credentials to another origin.
        if urlparse(newurl).netloc != urlparse(req.full_url).netloc:
            redirected.remove_header("X-goog-api-key")
        return redirected


def download_google(a, job, url):
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.netloc != "generativelanguage.googleapis.com":
        raise a.ApiError("Unexpected Google download origin; API key was not sent.")
    request = urllib.request.Request(url, headers={"x-goog-api-key": a.key_for("google")})
    opener = urllib.request.build_opener(GoogleDownloadRedirect())
    dest = a.MEDIA / "video" / (job["id"]+".mp4")
    dest.parent.mkdir(parents=True, exist_ok=True)
    temp = dest.with_suffix(".part")
    with opener.open(request, timeout=300) as r, temp.open("wb") as f:
        while True:
            chunk = r.read(1024*1024)
            if not chunk: break
            f.write(chunk)
    temp.replace(dest)
    return dest.relative_to(a.DATA).as_posix()


def resume(a, job):
    if job.get("resume_adapter") == "sync":
        if (job.get("output") or {}).get("images"):
            job["warn"] = "Completed images recovered; interrupted image calls were not resubmitted. Check provider billing."
            return
        raise a.ApiError("UNKNOWN_SUBMISSION: synchronous image response interrupted. Check Google before manually running again; no automatic retry.")
    if job.get("resume_adapter") == "google_veo":
        deadline = time.monotonic()+3600
        while time.monotonic() < deadline:
            r = call(a, "google", "GET", job["pid"], timeout=60)
            if r.get("error"):
                mark(a, job, cost=0, billing_unknown=False)
                raise a.ApiError("Veo generation failed: "+a.scrub(json.dumps(r["error"]))[:400])
            if r.get("done"):
                response = (r.get("response") or {}).get("generateVideoResponse") or r.get("response") or {}
                samples = response.get("generatedSamples") or []
                if not samples:
                    mark(a, job, cost=0, billing_unknown=False)
                    raise a.ApiError("Veo completed without a video; inspect provider result/filter details.")
                url = (samples[0].get("video") or {}).get("uri")
                mark(a, job, result_uri=url, provider_completed=True, phase="Downloading Veo video", cost_basis="tariff_estimate")
                file = download_google(a, job, url)
                mark(a, job, output={"video": {"file": file, "url": ""}})
                return
            a.set_phase(job, text="Veo is generating")
            time.sleep(max(4, a.POLL))
        raise a.ApiError("POLL_INTERRUPTED: Veo is still processing after 60 minutes. Operation ID is saved; do not submit again.")
    if job.get("resume_adapter") == "ws":
        files, errors = [], []
        for i, pid in enumerate(job.get("pids") or [job["pid"]]):
            try:
                outs = a.wait_ws(pid, a.key_for("wavespeed"), slow=job["kind"] == "video", job=job)
            except Exception as e:
                errors.append(a.scrub(e)[:300])
                continue
            mark(a, job, provider_completed=True, cost_basis="tariff_estimate")
            for k, value in enumerate(outs):
                url = value.get("url") if isinstance(value, dict) else value
                try: file = a.download(url, job["kind"], job["id"]+f"_{i}_{k}")
                except Exception: file = None
                files.append({"file": file, "url": url})
                output_key = {"image": "images", "video": "video", "audio": "audio"}.get(job["kind"], "video")
                mark(a, job, output={output_key: files[:] if job["kind"] == "image" else files[0]})
        if not files: raise a.ApiError("; ".join(errors) or "Provider completed without media output.")
        if errors:
            mark(a, job, warn="Some outputs could not be recovered. Completed outputs are retained. "+"; ".join(errors), billing_unknown=True, cost_basis="unknown")
        output_key = {"image": "images", "video": "video", "audio": "audio"}.get(job["kind"], "video")
        mark(a, job, output={output_key: files if job["kind"] == "image" else files[0]})
        return
    raise a.ApiError("No adapter available for this saved job.")


def save_keys(a, data):
    incoming = data.get("keys") or {}
    if not isinstance(incoming, dict) or set(incoming)-{"XAI_API_KEY", "GEMINI_API_KEY", "DEEPSEEK_API_KEY"}:
        raise a.ApiError("Only xAI, Google and DeepSeek keys can be saved here.")
    values = {}
    for k, v in incoming.items():
        if not isinstance(v, str) or any(c in v for c in "\r\n\x00") or len(v) > 512:
            raise a.ApiError("Invalid API key format.")
        if v.strip(): values[k] = v.strip()
    path = a.HERE / "keys.txt"
    with a.LOCK:
        old = path.read_text(encoding="utf-8-sig") if path.exists() else ""
        lines = [line for line in old.splitlines() if line.split("=", 1)[0].strip() not in values]
        text = "\n".join(lines+[k+"="+v for k, v in values.items()])+"\n"
        if values:
            temp = path.with_name("keys.codex.tmp")
            temp.write_text(text, encoding="utf-8")
            temp.replace(path)
        a.KEYS.clear(); a.KEYS.update(a.load_keys())
    return {"keys": {p: bool(a.KEYS.get(k)) for p, k in a.KEY_OF.items()}}


def check_key(a, provider):
    if provider not in ("xai", "google", "deepseek"): raise a.ApiError("Unsupported connection check.")
    r = call(a, provider, "GET", "models", timeout=30)
    models = r.get("models") or r.get("data") or []
    ids = {re.sub(r"^models/", "", str(x.get("name") or x.get("id") or "")) for x in models}
    wanted = [m for rows in catalog().values() for m in rows if m["provider"] == provider]
    return {"ok": True, "models": [{"id": m["id"], "listed": m["api_model"] in ids} for m in wanted],
            "note": "Key can list models. Paid generation and billing access have not been tested."}
