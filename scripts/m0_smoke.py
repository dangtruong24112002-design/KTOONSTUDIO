"""M0 smoke test on WaveSpeedAI — throwaway script (see docs/M0_SMOKE_TEST.md).

Usage (from the project folder):
  python scripts/m0_smoke.py plan     # free: config check, money spent so far, steps done
  python scripts/m0_smoke.py t1       # paid: two 9:16 lock-portrait candidates (~$0.054)

T2-T4 are added after the owner has reviewed T1.

Every call is appended to data/m0_log.jsonl. Money spent is recomputed from that log on every
start, so a killed run never loses track of the budget, and finished steps are skipped.
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import httpx
import yaml
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "m0"
LOG = ROOT / "data" / "m0_log.jsonl"
load_dotenv(ROOT / ".env")

CFG = yaml.safe_load((ROOT / "config" / "models.yaml").read_text(encoding="utf-8"))
WS = CFG["providers"]["wavespeed"]
BASE_URL = (os.getenv("WAVESPEED_BASE_URL") or WS["base_url"]).rstrip("/")
CAP_TOTAL = float(CFG["budgets"]["m0_test"])
CAP_STEP = {"t1": 0.20}  # owner's per-step limits

KEYFRAME = CFG["jobs"]["keyframe"]["primary"]  # seedream-v5.0-flash
POLL_S = 2
TIMEOUT_S = 600


def _headers() -> dict:
    return {"Authorization": f"Bearer {os.environ['WAVESPEED_API_KEY']}", "Content-Type": "application/json"}


# ---------------------------------------------------------------- ledger

def read_log() -> list[dict]:
    if not LOG.exists():
        return []
    return [json.loads(l) for l in LOG.read_text(encoding="utf-8").splitlines() if l.strip()]


def spent(prefix: str = "") -> float:
    return round(sum(r.get("cost_usd", 0) for r in read_log() if r.get("step", "").startswith(prefix)), 4)


def log(entry: dict) -> None:
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a", encoding="utf-8") as f:
        f.write(json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), **entry}, ensure_ascii=False) + "\n")


def done(step: str) -> dict | None:
    return next((r for r in read_log() if r.get("step") == step and r.get("ok")), None)


def guard(step: str, estimate: float) -> None:
    group = step.split("_")[0]
    if spent() + estimate > CAP_TOTAL:
        sys.exit(f"DUNG: {step} se lam vuot tran tong ${CAP_TOTAL:.2f} (da chi ${spent():.3f}).")
    cap = CAP_STEP.get(group)
    if cap is not None and spent(group) + estimate > cap:
        sys.exit(f"DUNG: {step} se lam vuot tran buoc {group} ${cap:.2f} (da chi ${spent(group):.3f}).")


def balance() -> float | None:
    """Account balance, if the endpoint answers. Free call; used to measure true cost."""
    try:
        r = httpx.get(f"{BASE_URL}/balance", headers=_headers(), timeout=20)
        return float(r.json()["data"]["balance"])
    except Exception:
        return None


# ---------------------------------------------------------------- WaveSpeed call

def run(step: str, model: str, params: dict, price: float, ext: str) -> Path | None:
    """Submit one prediction, poll to the end, download the first output, log everything."""
    out = OUT / f"{step}.{ext}"
    if done(step) and out.exists():
        print(f"[{step}] da xong truoc do, bo qua -> {out}")
        return out
    guard(step, price)

    t0 = time.time()
    body: dict = {}
    pred_id = None
    with httpx.Client(headers=_headers(), timeout=60) as c:
        r = c.post(f"{BASE_URL}/{model}", json=params)
        if r.status_code >= 400:
            log({"step": step, "model": model, "params": params, "http": r.status_code,
                 "response": r.text[:4000], "ok": False, "cost_usd": 0, "latency_s": round(time.time() - t0, 1)})
            print(f"[{step}] LOI khi gui yeu cau: HTTP {r.status_code}\n{r.text[:1500]}")
            return None
        pred_id = r.json()["data"]["id"]
        while time.time() - t0 < TIMEOUT_S:
            time.sleep(POLL_S)
            body = c.get(f"{BASE_URL}/predictions/{pred_id}/result").json().get("data", {})
            if body.get("status") in ("completed", "failed", "cancelled", "timeout", "deleted"):
                break

    latency = round(time.time() - t0, 1)
    ok = body.get("status") == "completed" and bool(body.get("outputs"))
    url = body["outputs"][0] if ok else None
    if ok:
        OUT.mkdir(parents=True, exist_ok=True)
        out.write_bytes(httpx.get(url, timeout=300, follow_redirects=True).content)
    # Failed predictions are logged at list price too until M0 proves they are not billed.
    cost = price if (ok or body.get("status") == "failed") else 0.0
    log({"step": step, "model": model, "params": params, "prediction_id": pred_id,
         "status": body.get("status"), "error": body.get("error"), "timings": body.get("timings"),
         "has_nsfw_contents": body.get("has_nsfw_contents"), "output_url": url,
         "file": str(out) if ok else None, "ok": ok, "cost_usd": cost, "latency_s": latency})
    print(f"[{step}] {'OK' if ok else 'THAT BAI: ' + str(body.get('error'))}  {latency}s  ~${cost:.3f}"
          + (f"  -> {out}" if ok else ""))
    return out if ok else None


# ---------------------------------------------------------------- prompts (PROMPT_RULES.md)

# Lead male, 7-dimension character formula. Fictional person.
LEAD_MALE = (
    # 1 age / ethnicity
    "A fictional 32-year-old American man of European descent, rugged-handsome, strong oval face. "
    # 2 skin / texture
    "Warm-toned fair skin with natural texture, retain true micro pores and skin texture, "
    "light even stubble along the jaw. "
    # 3 facial details
    "Deep-set almond-shaped eyes, defined brow bone, straight narrow nose bridge, medium lips with "
    "a firm upper lip, sharp squared jawline. "
    # 4 eyes / soul
    "Steady grey-blue eyes; a calm, guarded gaze that hides quiet resentment and self-control. "
    # 5 hair
    "Short dark-brown hair, thick and slightly tousled, side-parted, a few strands catching the key light. "
    # 6 clothing
    "Tailored charcoal-grey wool suit jacket over a crisp white cotton shirt, top button open, no tie, "
    "fabric with fine visible weave. "
    # 7 body / mood
    "Broad straight shoulders, upright composed posture; vertical 9:16 medium close-up from chest up, "
    "facing the camera, looking straight into the lens; restrained cinematic tension."
)

PORTRAIT_T1 = (
    "Photoreal cinematic film still, shot on 35mm, 85mm lens, shallow depth of field. "
    + LEAD_MALE
    + " Soft key light from camera left, gentle rim light, dark muted grey-blue background with subtle "
    "bokeh, natural skin tones, true-to-life color grading, sharp focus on the eyes. "
    "No text, no watermark, no logo, no jewelry, no rings, no sunglasses, no hands in frame, "
    "no plastic skin, no over-smoothing, no cartoon, no illustration, no AI-feel artifacts."
)


# ---------------------------------------------------------------- steps

def cmd_plan() -> None:
    key = os.getenv("WAVESPEED_API_KEY")
    print("Key WaveSpeed trong .env:", "CO" if key else "THIEU")
    b = balance() if key else None
    print("So du tai khoan:", f"${b:.4f}" if b is not None else "khong doc duoc")
    print(f"Da chi M0: ${spent():.3f} / tran ${CAP_TOTAL:.2f}")
    for s in ("t1_a", "t1_b"):
        print(f"  {s:6s} {'xong' if done(s) else 'chua'}")


def cmd_t1() -> None:
    before = balance()
    params = {"prompt": PORTRAIT_T1, "aspect_ratio": "9:16", "resolution": "2k", "output_format": "png"}
    for step in ("t1_a", "t1_b"):  # model has no seed parameter: two calls give two variants
        run(step, KEYFRAME["model"], params, KEYFRAME["price_per_image"], "png")
    after = balance()
    if before is not None and after is not None:
        print(f"So du truoc ${before:.4f}, sau ${after:.4f}, bi tru that ${before - after:.4f}")
        log({"step": "t1_balance", "before": before, "after": after, "delta": round(before - after, 4),
             "ok": True, "cost_usd": 0})


if __name__ == "__main__":
    cmds = {"plan": cmd_plan, "t1": cmd_t1}
    if len(sys.argv) != 2 or sys.argv[1] not in cmds:
        sys.exit(__doc__)
    if not os.getenv("WAVESPEED_API_KEY"):
        sys.exit("Thieu WAVESPEED_API_KEY trong file .env")
    cmds[sys.argv[1]]()
