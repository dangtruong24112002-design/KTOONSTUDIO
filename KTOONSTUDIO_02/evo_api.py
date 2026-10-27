"""KTOON 🧬 Tiến hoá công thức (server 4.2.11) — evidence-driven recipe evolution, modelled on OpenSpace's skill engine.

OpenSpace pipeline:  TriggerJob → EvidencePacket → DecisionRationale → Admission → staged authoring → validation → commit
KTOON pipeline:      job run    → evidence + your signals → AI analysis (FIX / DERIVED / CAPTURED) → hard rule gates
                     → candidate (A/B optional) → you approve → new version (provisional → trusted by real outcomes)

Storage (plain text, on this computer only): data/evo/
  evidence.jsonl   one "start" + one "end" line per job (recipe + version, model, prompt, inputs, cost, error, outputs)
  signals.jsonl    your actions on outputs (👍/👎 + reason, chosen, kept in Library, downloaded, inpainted) and AI QC hints
  recipes.json     recipes: versions (lineage DAG: imported / manual / fixed / derived / captured), active version
  candidates.json  AI proposals with admission results, A/B links and status
  lessons.json     consolidated lessons ("dream"), also written to data/core as a core document
  settings.json    automation level and models
  backup/          daily copy of the json files
"""
import hashlib
import json
import os
import re
import shutil
import threading
import time
from datetime import datetime
from pathlib import Path

LOCK = threading.RLock()
ST = {"dir": None, "cache": None, "sig": None}
KINDS = ("image", "video", "llm")
TRUST_MIN_SUCCESSES = 3
LESSON_DOC = "KTOON_Bai_hoc_san_xuat.md"

# ---- environment failures are never the recipe's fault (OpenSpace admission: _ENVIRONMENT_FAILURE_TERMS)
ENV_TERMS = ("out of funds", "insufficient", "credit", "rejected the key", "missing ", "api key", "http 401", "http 403", "(http 401", "(http 403",
             "cannot connect", "did not respond", "unknown_submission", "timed out", "timeout", "network", "connection", "cap exceeded",
             "khởi động lại", "not found: ", "file not found", "đang đọc kích thước", "nối 1 ảnh", "chưa chọn")
POLICY_TERMS = ("[blocked", "[copyright", "[bản quyền", "policy", "moderation", "sensitive")
# ---- proposals that would store secrets / temporary context (OpenSpace: _EPHEMERAL_CAPTURE_TERMS)
EPHEMERAL_TERMS = ("api key", "apikey", "_api_key", "secret", "password", "token=", "bearer ", "signature=", "x-amz-", "expires=",
                   "presigned", "signed url", "/tmp/", "keys.txt")
# ---- KTOON hard rule: the system never learns to get around content / copyright filters
EVASION_TERMS = ("bypass", "circumvent", "evade", "evasion", "get around the filter", "avoid the filter", "avoid detection", "trick the",
                 "fool the", "jailbreak", "obfuscat", "misspell", "leetspeak", "l33t", "lách", "né bộ lọc", "qua mặt", "đánh lừa", "vượt bộ lọc",
                 "tránh bị phát hiện", "tránh kiểm duyệt", "uncensor")
SLOT_REQUIRED = {"enh": ["IMAGE TYPE:"], "s3shot": ["JSON"], "s3vid": ["{{camera_and_action}}"]}


def init(data_dir):
    d = Path(data_dir) / "evo"
    (d / "backup").mkdir(parents=True, exist_ok=True)
    ST["dir"] = d


def _p(name):
    return ST["dir"] / name


def _rj(name, dflt):
    p = _p(name)
    if not p.is_file():
        return dflt
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        try:
            shutil.copyfile(p, p.with_name(p.stem + f".broken_{datetime.now().strftime('%Y%m%d_%H%M%S')}" + p.suffix))
        except OSError:
            pass
        return dflt


def _wj(name, obj):
    d = ST["dir"]
    p = _p(name)
    bk = d / "backup" / f"{p.stem}_{datetime.now().strftime('%Y%m%d')}{p.suffix}"
    if p.is_file() and not bk.exists():
        try:
            shutil.copyfile(p, bk)
            olds = sorted((d / "backup").glob(f"{p.stem}_*{p.suffix}"))
            for o in olds[:-45]:
                o.unlink()
        except OSError:
            pass
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, p)


def _append(name, rec):
    with LOCK:
        with open(_p(name), "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        ST["cache"] = None


def _lines(name):
    p = _p(name)
    if not p.is_file():
        return []
    out = []
    with open(p, encoding="utf-8") as f:
        for ln in f:
            ln = ln.strip()
            if not ln:
                continue
            try:
                out.append(json.loads(ln))
            except ValueError:
                continue
    return out


def _h(text):
    """FNV-1a 32-bit of the UTF-8 text — the UI computes the same hash (evoHash) so runs map to the exact version used."""
    h = 0x811C9DC5
    for b in str(text or "").encode("utf-8"):
        h = ((h ^ b) * 0x01000193) & 0xFFFFFFFF
    return f"{h:08x}"


def _resolve_vid(rid, vid, h, R=None):
    R = R if R is not None else _recipes()["recipes"]
    r = R.get(rid)
    if not r:
        return vid or (f"h:{h}" if h else "")
    if vid and vid in r["versions"]:
        return vid
    if h:
        for v in r["versions"].values():
            if v.get("h") == h:
                return v["vid"]
        return f"h:{h}"
    return vid or r.get("active") or ""


def _norm(t):
    return re.sub(r"\s+", " ", str(t or "")).strip().lower()


def _has(text, terms):
    low = str(text or "").lower()
    return [t for t in terms if t in low]


def err_class(err):
    e = str(err or "").lower()
    if not e:
        return ""
    if any(t in e for t in POLICY_TERMS):
        return "policy"
    if any(t in e for t in ENV_TERMS):
        return "env"
    return "other"


# ----------------------------------------------------------------- evidence (called from app.py)
def tracked(req):
    if req.get("kind") not in KINDS:
        return False
    node = str(req.get("node") or "")
    return bool(req.get("rx")) or (node and not node.startswith("__"))


def on_start(jid, req, job):
    try:
        if not ST["dir"] or not tracked(req):
            return
        rx = req.get("rx") if isinstance(req.get("rx"), dict) else {}
        kind = req.get("kind")
        rid = str(rx.get("id") or f"free.{kind}.{req.get('model') or ''}")[:120]
        vid0 = str(rx.get("vid") or "")[:60]
        chain = None
        if kind in ("image", "video") and rid.startswith("free."):
            hit = chain_for([req.get("prompt")] + list(req.get("texts") or []))
            if hit:
                rid, vid0, chain = hit["id"], hit.get("vid") or "", hit.get("via")
                rx = dict(rx, h=hit.get("h") or "")
        if not vid0.startswith("cand:") and not chain:
            vid0 = _resolve_vid(rid, vid0 if vid0 not in ("base",) else "", str(rx.get("h") or "")[:12])
        ins = []
        for k in ("images", "videos", "audios"):
            for x in req.get(k) or []:
                if isinstance(x, str):
                    ins.append(x[:300])
        _append("evidence.jsonl", {
            "t": "start", "job": jid, "ts": time.time(), "kind": kind, "model": req.get("model"), "node": req.get("node"),
            "episode": req.get("episode"), "series": req.get("series"), "rx": {"id": rid, "vid": vid0, "h": str(rx.get("h") or "")[:12],
            "mod": bool(rx.get("mod")), "ab": str(rx.get("ab") or "")[:40], "title": str(rx.get("title") or "")[:120], "chain": chain or ""},
            "inj": int(req.get("evo_inj") or 0),
            "prompt": str(req.get("prompt") or "")[:8000], "system": str(req.get("system") or "")[:3000] if kind == "llm" else "",
            "inputs": ins[:24], "res": req.get("res"), "aspect": req.get("aspect"), "duration": req.get("duration"),
            "resolution": req.get("resolution"), "count": req.get("count"), "est": job.get("est")})
        RXJ[jid] = {"id": rid, "vid": vid0, "h": str(rx.get("h") or "")[:12]}
    except Exception:
        pass


def on_end(job):
    try:
        if not ST["dir"] or job.get("kind") not in KINDS:
            return
        o = job.get("output") or {}
        outs = []
        for x in o.get("images") or []:
            if isinstance(x, dict) and (x.get("file") or x.get("url")):
                outs.append(x.get("file") or x.get("url"))
        v = o.get("video")
        if isinstance(v, dict) and (v.get("file") or v.get("url")):
            outs.append(v.get("file") or v.get("url"))
        th = ""
        if o.get("text") and job.get("status") == "done":
            th = _h(_norm(o.get("text")))
            rx0 = RXJ.get(job["id"]) or {}
            if rx0.get("id") and not str(rx0["id"]).startswith("free."):
                CHAIN[th] = dict(rx0, via=job["id"])
        _append("evidence.jsonl", {"t": "end", "job": job["id"], "ts": time.time(), "status": job.get("status"), "cost": job.get("cost") or 0, "th": th,
                                   "error": str(job.get("error") or "")[:500], "ecls": err_class(job.get("error")) if job.get("status") == "failed" else "",
                                   "outs": outs, "text": str(o.get("text") or "")[:3000] if o.get("text") else ""})
    except Exception:
        pass


def signal(d):
    items = d.get("items") if isinstance(d.get("items"), list) else [d]
    n = 0
    for it in items[:200]:
        sig = str(it.get("sig") or "")
        if sig not in ("rate", "chosen", "kept", "fixed", "deleted", "qc", "unrate"):
            continue
        rec = {"ts": time.time(), "sig": sig, "file": str(it.get("file") or "")[:400], "job": str(it.get("job") or "")[:60],
               "val": int(it.get("val") or 0), "reason": str(it.get("reason") or "")[:400],
               "tags": [str(t)[:40] for t in (it.get("tags") or [])][:8], "src": str(it.get("src") or "")[:40]}
        if not rec["file"] and not rec["job"]:
            continue
        _append("signals.jsonl", rec)
        n += 1
    return {"ok": True, "n": n}


# ----------------------------------------------------------------- recipes (versions / lineage)
def _recipes():
    return _rj("recipes.json", {"recipes": {}})


def recipe_op(d):
    op = d.get("op") or "list"
    with LOCK:
        R = _recipes()
        rs = R["recipes"]
        if op == "list":
            return {"recipes": rs}
        if op == "ensure":
            out = {}
            for it in (d.get("items") or [])[:100]:
                rid, text = str(it.get("id") or "")[:120], str(it.get("text") or "")
                if not rid or not text.strip():
                    continue
                r = rs.get(rid)
                if not r:
                    vid = "v1"
                    rs[rid] = r = {"id": rid, "kind": it.get("kind") or "image", "slot": it.get("slot") or rid.split(".")[0],
                                   "name": str(it.get("name") or rid)[:120], "created": time.time(), "enabled": True, "active": vid,
                                   "versions": {vid: {"vid": vid, "text": text, "h": _h(text), "parent": None, "origin": "imported",
                                                      "summary": "Original in the app", "created": time.time(), "gen": 0}}}
                else:
                    if it.get("name"):
                        r["name"] = str(it["name"])[:120]
                    h = _h(text)
                    if not any(v.get("h") == h for v in r["versions"].values()):
                        par = r["versions"].get(r["active"]) or {}
                        vid = f"v{len(r['versions']) + 1}"
                        r["versions"][vid] = {"vid": vid, "text": text, "h": h, "parent": r["active"], "origin": "manual",
                                              "summary": "Edited by you in the app", "created": time.time(), "gen": int(par.get("gen") or 0) + 1}
                        r["active"] = vid
                hh = _h(text)
                out[rid] = {"active": r["active"], "text": r["versions"][r["active"]]["text"], "matched": next((v["vid"] for v in r["versions"].values() if v.get("h") == hh), "")}
            _wj("recipes.json", R)
            return {"ok": True, "recipes": out}
        rid = str(d.get("id") or "")
        if op == "activate":
            r = rs.get(rid)
            if not r or d.get("vid") not in r["versions"]:
                return {"error": "Version not found."}
            r["active"] = d["vid"]
            _wj("recipes.json", R)
            return {"ok": True}
        if op == "rename":
            if rid in rs:
                rs[rid]["name"] = str(d.get("name") or rs[rid]["name"])[:120]
                _wj("recipes.json", R)
            return {"ok": True}
        if op == "enable":
            if rid in rs:
                rs[rid]["enabled"] = bool(d.get("on"))
                _wj("recipes.json", R)
            return {"ok": True}
        if op == "commit":
            return _commit(R, str(d.get("cid") or ""), d)
        if op == "export":
            return {"format": "ktoon-recipes", "v": 1, "exported": datetime.now().isoformat(timespec="seconds"), "recipes": rs,
                    "lessons": _rj("lessons.json", {}).get("lessons", [])}
        if op == "import":
            src = d.get("data") or {}
            if src.get("format") != "ktoon-recipes":
                return {"error": "This file is not a KToons recipe set."}
            n = 0
            for k, r in (src.get("recipes") or {}).items():
                if not isinstance(r, dict) or not r.get("versions"):
                    continue
                cur = rs.get(k)
                if not cur:
                    rs[k] = r
                    n += 1
                    continue
                hs = {v.get("h") for v in cur["versions"].values()}
                for v in r["versions"].values():
                    if v.get("h") not in hs:
                        nv = f"v{len(cur['versions']) + 1}"
                        cur["versions"][nv] = dict(v, vid=nv, origin=v.get("origin") or "imported", summary="(imported) " + str(v.get("summary") or ""))
                        n += 1
            _wj("recipes.json", R)
            return {"ok": True, "added": n}
    return {"error": "unknown op"}


def _commit(R, cid, d):
    C = _rj("candidates.json", {"cands": {}})
    c = C["cands"].get(cid)
    if not c:
        return {"error": "Proposal not found."}
    if (c.get("admission") or {}).get("outcome") == "reject":
        return {"error": "The proposal was blocked by a hard rule — it cannot be applied."}
    text = str(d.get("text") or c.get("new_text") or "")
    if not text.strip():
        return {"error": "The proposal is empty."}
    rs, now = R["recipes"], time.time()
    if c["type"] == "fix" or (c["type"] == "derived" and not c.get("as_new")):
        r = rs.get(c["target"])
        if not r:
            return {"error": "The original recipe no longer exists."}
        par = r["versions"].get(c.get("base_vid") or r["active"]) or r["versions"][r["active"]]
        vid = f"v{len(r['versions']) + 1}"
        r["versions"][vid] = {"vid": vid, "text": text, "h": _h(text), "parent": par["vid"], "origin": "fixed" if c["type"] == "fix" else "derived",
                              "summary": c.get("summary") or c.get("direction") or "", "created": now, "gen": int(par.get("gen") or 0) + 1,
                              "cand": cid, "evidence": c.get("evidence", [])[:30]}
        r["active"] = vid
        rid = r["id"]
    else:
        base = rs.get(c.get("target") or "")
        kind = c.get("kind") or (base or {}).get("kind") or "image"
        if base and base.get("slot") in ("enh", "sheet"):
            sid = "st" + hashlib.sha1(f"{cid}{now}".encode()).hexdigest()[:6]
            rid = f"{base['slot']}.{sid}"
            slot = base["slot"]
        else:
            rid = f"cap.{kind}.{hashlib.sha1(f'{cid}{now}'.encode()).hexdigest()[:6]}"
            slot = "prompt"
        par = base["versions"][base["active"]] if base else None
        rs[rid] = {"id": rid, "kind": kind, "slot": slot, "name": str(c.get("name") or ("Captured recipe" if c["type"] == "captured" else "New branch"))[:120],
                   "created": now, "enabled": True, "active": "v1", "parent_recipe": (base or {}).get("id"),
                   "versions": {"v1": {"vid": "v1", "text": text, "h": _h(text), "parent": (f"{base['id']}:{par['vid']}" if base else None),
                                       "origin": "captured" if c["type"] == "captured" else "derived", "summary": c.get("summary") or c.get("direction") or "",
                                       "created": now, "gen": (int(par.get("gen") or 0) + 1) if par else 0, "cand": cid, "evidence": c.get("evidence", [])[:30]}}}
    c["status"] = "committed"
    c["committed"] = {"rid": rid, "ts": now}
    _wj("recipes.json", R)
    _wj("candidates.json", C)
    return {"ok": True, "id": rid, "vid": rs[rid]["active"]}


# ----------------------------------------------------------------- scoring
def _load():
    """Join evidence + signals into per-job / per-output records (cached on file mtimes)."""
    try:
        sig = tuple((_p(n).stat().st_mtime, _p(n).stat().st_size) if _p(n).is_file() else (0, 0) for n in ("evidence.jsonl", "signals.jsonl"))
    except OSError:
        sig = None
    if ST["cache"] is not None and ST["sig"] == sig:
        return ST["cache"]
    jobs = {}
    for e in _lines("evidence.jsonl"):
        j = jobs.setdefault(e.get("job"), {"job": e.get("job")})
        if e.get("t") == "start":
            j.update({k: v for k, v in e.items() if k != "t"})
        elif e.get("t") == "end":
            j.update(status=e.get("status"), cost=e.get("cost") or 0, error=e.get("error") or "", ecls=e.get("ecls") or "", outs=e.get("outs") or [],
                     text=e.get("text") or "", ts_end=e.get("ts"))
    sigs_f, sigs_j = {}, {}
    for s in _lines("signals.jsonl"):
        if s.get("file"):
            sigs_f.setdefault(s["file"], []).append(s)
        if s.get("job"):
            sigs_j.setdefault(s["job"], []).append(s)
    used = set()
    for j in jobs.values():
        for x in j.get("inputs") or []:
            used.add(x)
    by_node = {}
    for j in jobs.values():
        if j.get("rx") and j.get("node"):
            by_node.setdefault((j.get("episode"), j.get("node")), []).append(j)
    # per-output verdicts
    for j in jobs.values():
        if not j.get("rx"):
            continue
        outs = []
        for f in j.get("outs") or []:
            outs.append(_verdict(f, sigs_f.get(f, []), f in used))
        if j.get("kind") == "llm" and j.get("status") == "done":
            outs.append(_verdict("", sigs_j.get(j["job"], []), False, job=j["job"]))
        j["vouts"] = outs
    for lst in by_node.values():                      # several versions on one node: the one you kept wins, older unchosen ones count as not chosen
        lst.sort(key=lambda x: x.get("ts") or 0)
        win = None
        for j in lst:
            for o in j.get("vouts") or []:
                if o["v"] == "acc" and o["why"] in ("chosen", "kept", "used", "rate"):
                    win = (j.get("ts") or 0)
        if win is None:
            continue
        for j in lst:
            for o in j.get("vouts") or []:
                if o["v"] == "pend" and (j.get("ts") or 0) < win:
                    o.update(v="rej", why="not_chosen")
    ST["cache"], ST["sig"] = {"jobs": jobs}, sig
    return ST["cache"]


def _verdict(f, sl, used, job=None):
    sl = sorted(sl, key=lambda s: s.get("ts") or 0)
    rate = None
    flags = set()
    reason, tags, qc = "", [], None
    for s in sl:
        if s["sig"] == "rate":
            rate = s.get("val")
            reason, tags = s.get("reason") or "", s.get("tags") or []
        elif s["sig"] == "unrate":
            rate = None
        elif s["sig"] == "qc":
            qc = {"val": s.get("val"), "reason": s.get("reason"), "tags": s.get("tags")}
        else:
            flags.add(s["sig"])
    if rate == 1:
        v, why = "acc", "rate"
    elif rate == -1:
        v, why = "rej", "rate"
    elif "deleted" in flags:
        v, why = "rej", "deleted"
    elif "fixed" in flags:
        v, why = "fix", "fixed"
    elif "kept" in flags:
        v, why = "acc", "kept"
    elif used:
        v, why = "acc", "used"
    elif "chosen" in flags:
        v, why = "acc", "chosen"
    else:
        v, why = "pend", ""
    return {"f": f, "job": job, "v": v, "why": why, "reason": reason, "tags": tags, "qc": qc}


def _stats(jobs):
    s = {"runs": 0, "done": 0, "fail": 0, "env": 0, "policy": 0, "outs": 0, "acc": 0, "rej": 0, "fix": 0, "pend": 0, "cost": 0.0, "nodes": 0,
         "last": 0, "reasons": {}, "trust": None, "since_fail": 0}
    nodes = set()
    obs = []
    for j in sorted(jobs, key=lambda x: x.get("ts") or 0):
        s["runs"] += 1
        s["last"] = max(s["last"], j.get("ts") or 0)
        s["cost"] += float(j.get("cost") or 0)
        nodes.add((j.get("episode"), j.get("node")))
        st = j.get("status")
        if st == "done":
            s["done"] += 1
        elif st == "failed":
            c = j.get("ecls") or "other"
            if c == "env":
                s["env"] += 1
            elif c == "policy":
                s["policy"] += 1
            else:
                s["fail"] += 1
                obs.append(0)
        for o in j.get("vouts") or []:
            s["outs"] += 1
            s[o["v"]] += 1
            if o["v"] == "acc":
                obs.append(1)
            elif o["v"] in ("rej", "fix"):
                obs.append(0)
                for t in (o.get("tags") or []) + ([o["why"]] if o["why"] in ("not_chosen", "deleted", "fixed") else []):
                    s["reasons"][t] = s["reasons"].get(t, 0) + 1
    s["nodes"] = len(nodes)
    judged = s["acc"] + s["rej"] + s["fix"]
    s["rate"] = round(s["acc"] / judged, 3) if judged else None
    s["score"] = round((s["acc"] + 1) / (judged + 2), 3)          # smoothed, used by the ranker
    s["cpa"] = round(s["cost"] / s["acc"], 4) if s["acc"] else None
    s["regen"] = round(s["runs"] / len(nodes), 2) if nodes else None
    s["cost"] = round(s["cost"], 4)
    s["obs"] = obs
    return s


def _trust(origin, obs):
    state = "trusted" if origin in ("imported", "manual") else "provisional"
    since = 0
    for o in obs:
        if o == 0:
            state, since = "provisional", 0
        else:
            since += 1
            if state == "provisional" and since >= TRUST_MIN_SUCCESSES:
                state = "trusted"
    return state, since


def summary(d):
    days = float(d.get("days") or 0)
    series = d.get("series") or ""
    with LOCK:
        L = _load()
        R = _recipes()["recipes"]
        C = _rj("candidates.json", {"cands": {}})["cands"]
    t0 = time.time() - days * 86400 if days > 0 else 0
    jobs = [j for j in L["jobs"].values() if j.get("rx") and (j.get("ts") or 0) >= t0 and (not series or j.get("series") == series)]
    by_r, by_v = {}, {}
    c2v = {}
    for rid0, r0 in R.items():
        for v0 in r0["versions"].values():
            if v0.get("cand"):
                c2v[v0["cand"]] = (rid0, v0["vid"])
    for j in jobs:
        rid, vid = j["rx"]["id"], j["rx"].get("vid") or ""
        if vid.startswith("h:") or (not vid and rid in R):
            vid = _resolve_vid(rid, "", vid[2:] if vid.startswith("h:") else j["rx"].get("h"), R)
        by_r.setdefault(rid, []).append(j)
        by_v.setdefault((rid, vid), []).append(j)
        if vid.startswith("cand:") and vid[5:] in c2v and c2v[vid[5:]][0] == rid:      # A/B runs of an approved candidate count for the version it became
            by_v.setdefault(c2v[vid[5:]], []).append(j)
    out = []
    for rid, r in R.items():
        vers = []
        for vid, v in r["versions"].items():
            st = _stats(by_v.get((rid, vid), []))
            st["trust"], st["since_fail"] = _trust(v.get("origin"), st.pop("obs"))
            vers.append(dict({k: v.get(k) for k in ("vid", "parent", "origin", "summary", "created", "gen", "cand")}, chars=len(v.get("text") or ""), stats=st))
        a = _stats(by_r.get(rid, []))
        a.pop("obs")
        act = next((x for x in vers if x["vid"] == r["active"]), None)
        out.append({"id": rid, "name": r.get("name"), "kind": r.get("kind"), "slot": r.get("slot"), "active": r.get("active"), "enabled": r.get("enabled", True),
                    "parent_recipe": r.get("parent_recipe"), "versions": sorted(vers, key=lambda x: x.get("created") or 0), "stats": a,
                    "trust": act["stats"]["trust"] if act else "trusted"})
    free = []
    for rid, js in by_r.items():
        if rid in R:
            continue
        st = _stats(js)
        st.pop("obs")
        free.append({"id": rid, "name": rid.replace("free.", "Free prompt · ").replace("cand.", "Proposal "), "kind": js[0].get("kind"), "stats": st})
    cand_stats = {}
    for (rid, vid), js in by_v.items():
        if vid.startswith("cand:"):
            st = _stats(js)
            st.pop("obs")
            cand_stats[vid[5:]] = st
    tot = _stats(jobs)
    tot.pop("obs")
    return {"recipes": out, "free": free, "totals": tot, "cand_stats": cand_stats, "settings": settings({}),
            "open_cands": sum(1 for c in C.values() if c.get("status") in ("open", "ab")),
            "lessons_at": _rj("lessons.json", {}).get("at")}


def evidence(d):
    rid, vid, verdict = d.get("rx") or "", d.get("vid") or "", d.get("verdict") or ""
    lim = max(1, min(300, int(d.get("limit") or 60)))
    want = set(d.get("jobs") or [])
    with LOCK:
        L = _load()
    rows = []
    for j in sorted(L["jobs"].values(), key=lambda x: -(x.get("ts") or 0)):
        if not j.get("rx"):
            continue
        if want and j["job"] not in want:
            continue
        if rid and j["rx"]["id"] != rid:
            continue
        if vid and j["rx"].get("vid") != vid:
            continue
        vo = j.get("vouts") or []
        if verdict == "fail" and j.get("status") != "failed":
            continue
        if verdict in ("acc", "rej", "pend", "fix") and not any(o["v"] == verdict for o in vo):
            continue
        rows.append(dict({k: j.get(k) for k in ("job", "ts", "kind", "model", "rx", "node", "episode", "status", "cost", "error", "ecls", "inputs", "res", "aspect", "duration")},
                         prompt=(j.get("prompt") or "")[:600], outs=vo, text=(j.get("text") or "")[:400]))
        if len(rows) >= lim:
            break
    return {"rows": rows}


# ----------------------------------------------------------------- evidence packet for the analyzer (OpenSpace: EvidencePacket)
def packet(d):
    mode = d.get("mode") or "fix"
    rid = d.get("rx") or ""
    with LOCK:
        L = _load()
        R = _recipes()["recipes"]
    jobs = sorted([j for j in L["jobs"].values() if j.get("rx")], key=lambda x: -(x.get("ts") or 0))
    ids, imgs, parts = [], [], []

    def jline(j, why=""):
        vo = j.get("vouts") or []
        verd = ", ".join(f"{o['v']}{'(' + o['why'] + ')' if o['why'] else ''}{': ' + o['reason'] if o['reason'] else ''}{' [' + '/'.join(o['tags']) + ']' if o['tags'] else ''}"
                         + (f" · AI QC: {o['qc']['reason']}" if o.get("qc") and o["qc"].get("reason") else "") for o in vo) or "-"
        ids.append(j["job"])
        p = (j.get("prompt") or "")
        return (f"### EVIDENCE {j['job']} {why}\nrecipe={j['rx']['id']} version={j['rx'].get('vid') or '-'}{' (prompt edited by user in the node)' if j['rx'].get('mod') else ''} "
                f"model={j.get('model')} res={j.get('res') or j.get('resolution') or '-'} aspect={j.get('aspect') or '-'} status={j.get('status')} cost=${float(j.get('cost') or 0):.3f}\n"
                f"error_class={j.get('ecls') or '-'} error={(j.get('error') or '')[:300] or '-'}\ninputs={len(j.get('inputs') or [])} outputs={len(j.get('outs') or [])} verdicts: {verd}\n"
                f"prompt:\n{p[:2500]}\n" + (f"output text (head):\n{(j.get('text') or '')[:800]}\n" if j.get("text") else ""))
    if mode == "lessons":
        js = [j for j in jobs if j.get("status") == "failed" or any(o["v"] in ("rej", "fix", "acc") and (o["reason"] or o["tags"] or o["v"] == "acc") for o in j.get("vouts") or [])][:70]
        st = summary({})
        parts.append("## RECIPE SCOREBOARD\n" + "\n".join(f"- {r['name']} ({r['id']}): {r['stats']['runs']} runs, accept rate {r['stats']['rate']}, blocked {r['stats']['policy']}, "
                                                          f"top reasons {sorted(r['stats']['reasons'].items(), key=lambda x: -x[1])[:5]}" for r in st["recipes"] if r["stats"]["runs"]))
        parts += [jline(j) for j in js]
        return {"text": "\n\n".join(parts)[:60000], "ids": ids, "images": []}
    if mode == "capture":
        kind = d.get("kind") or ""
        js = [j for j in jobs if (j["rx"]["id"].startswith("free.") or j["rx"].get("mod")) and (not kind or j.get("kind") == kind)
              and any(o["v"] == "acc" for o in j.get("vouts") or [])][:24]
        if not js:
            return {"error": "No hand-written prompt has been accepted yet (thumbs up / chosen / saved / reused) to capture as a recipe."}
        exist = [f"- {r['name']} ({k}, {r['kind']}): {r['versions'][r['active']]['text'][:300]}" for k, r in R.items() if r.get("enabled", True)]
        parts.append("## EXISTING RECIPES (do not capture a duplicate of these)\n" + "\n".join(exist[:40]))
        parts.append("## ACCEPTED RUNS WITH USER-WRITTEN OR USER-EDITED PROMPTS")
        parts += [jline(j, "(accepted)") for j in js]
        for j in js[:4]:
            for o in j.get("vouts") or []:
                if o["v"] == "acc" and o["f"] and len(imgs) < 4 and re.search(r"\.(png|jpe?g|webp)$", o["f"], re.I):
                    imgs.append(o["f"])
        return {"text": "\n\n".join(parts)[:60000], "ids": ids, "images": imgs, "recipe": None}
    r = R.get(rid)
    if not r:
        return {"error": "Recipe not found."}
    act = r["versions"][r["active"]]
    mine = [j for j in jobs if j["rx"]["id"] == rid]
    bad = [j for j in mine if (j.get("status") == "failed" and j.get("ecls") != "env") or any(o["v"] in ("rej", "fix") for o in j.get("vouts") or [])][:18]
    good = [j for j in mine if any(o["v"] == "acc" for o in j.get("vouts") or [])][:8]
    edited_good = [j for j in good if j["rx"].get("mod")][:5]
    env = sum(1 for j in mine if j.get("ecls") == "env")
    if not bad and not edited_good:
        return {"error": "Nothing rejected / failed yet (or fixed by your own prompt edit) to analyse. Rate a few results first."}
    st = _stats(mine)
    st.pop("obs")
    parts.append(f"## RECIPE UNDER REVIEW\nid={rid} name={r.get('name')} kind={r.get('kind')} slot={r.get('slot')} active_version={r['active']} origin={act.get('origin')}\n"
                 f"stats: runs={st['runs']} accepted={st['acc']} rejected={st['rej']} fixed_by_inpaint={st['fix']} blocked={st['policy']} other_failures={st['fail']} "
                 f"environment_failures_ignored={env} accept_rate={st['rate']} avg_runs_per_node={st['regen']}\ntop rejection reasons: {sorted(st['reasons'].items(), key=lambda x: -x[1])[:8]}\n"
                 f"required placeholders/markers that must stay: {', '.join(re.findall(r'{{[a-z_]+}}', act['text']) + SLOT_REQUIRED.get(r.get('slot'), [])) or 'none'}\n"
                 f"=== ACTIVE RECIPE TEXT ===\n{act['text']}\n=== END RECIPE TEXT ===")
    parts.append("## REJECTED / FAILED RUNS")
    parts += [jline(j, "(bad)") for j in bad]
    parts.append("## ACCEPTED RUNS")
    parts += [jline(j, "(good" + (", prompt edited by user" if j["rx"].get("mod") else "") + ")") for j in good]
    for j in bad[:6]:
        for o in j.get("vouts") or []:
            if o["v"] in ("rej", "fix") and o["f"] and len(imgs) < 4 and re.search(r"\.(png|jpe?g|webp)$", o["f"], re.I):
                imgs.append(o["f"])
    return {"text": "\n\n".join(parts)[:70000], "ids": ids, "images": imgs, "recipe": {"id": rid, "slot": r.get("slot"), "kind": r.get("kind"), "vid": r["active"], "text": act["text"]}}


# ----------------------------------------------------------------- admission gates (OpenSpace: EvolutionAdmission — deterministic, before anything is staged)
def _sim(a, b):
    ta, tb = set(re.findall(r"\w+", _norm(a))), set(re.findall(r"\w+", _norm(b)))
    return len(ta & tb) / max(1, len(ta | tb))


def admit(s, R, valid_ids, jobs):
    typ = str(s.get("type") or "").lower()
    hard, warn = [], []
    tgt = str(s.get("target") or "")
    new = str(s.get("new_text") or "")
    ev = [x for x in (s.get("evidence") or []) if x in valid_ids]
    if typ not in ("fix", "derived", "captured"):
        hard.append("invalid_type")
    base = R.get(tgt)
    if typ in ("fix", "derived") and not base:
        hard.append("unknown_target_recipe")
    if typ == "captured" and tgt and tgt in R:
        warn.append("captured_has_target_ignored")
    if not ev:
        hard.append("missing_evidence")
    evj = [jobs.get(x) or {} for x in ev]
    if typ == "fix":
        fails = [j for j in evj if (j.get("status") == "failed" and j.get("ecls") in ("other", "policy")) or any(o["v"] in ("rej", "fix") for o in j.get("vouts") or [])]
        envs = [j for j in evj if j.get("ecls") == "env"]
        if not fails:
            hard.append("environment_failure_not_recipe_fault" if envs else "missing_failure_evidence")
        if fails and all(j.get("ecls") == "policy" for j in fails):
            warn.append("policy_driven: approve only if the new version makes the content SAFER (removes sensitive / real-person / copyrighted elements), never to get around a filter")
    if typ == "captured":
        if not any(any(o["v"] == "acc" for o in j.get("vouts") or []) for j in evj):
            hard.append("capture_without_accepted_evidence")
        for k, r in R.items():
            if r.get("kind") == (s.get("kind") or r.get("kind")) and _sim(new, r["versions"][r["active"]]["text"]) >= 0.85:
                hard.append(f"existing_recipe_covers:{k}")
                break
    if len(new.strip()) < 40:
        hard.append("empty_or_too_short")
    if base:
        old = base["versions"][base["active"]]["text"]
        if len(new) > max(4 * len(old), 12000):
            hard.append("too_long")
        for ph in set(re.findall(r"{{[a-z_]+}}", old)):
            if ph not in new:
                hard.append(f"missing_placeholder:{ph}")
        for req in SLOT_REQUIRED.get(base.get("slot"), []):
            if req in old and req not in new:
                hard.append(f"missing_marker:{req}")
        if _norm(new) == _norm(old):
            hard.append("no_change")
        elif _sim(new, old) < 0.25 and typ == "fix":
            warn.append("large_rewrite: the edit differs a lot from the old version — run an A/B test")
    eph = _has(new, EPHEMERAL_TERMS)
    if eph:
        hard.append("ephemeral_or_secret:" + ",".join(eph[:3]))
    eva = _has(new + " " + str(s.get("direction") or "") + " " + str(s.get("change_summary") or ""), EVASION_TERMS)
    if eva:
        hard.append("moderation_evasion:" + ",".join(eva[:3]))
    if _has(new, ("real person", "celebrity", "người thật", "người nổi tiếng")):
        warn.append("mentions_real_people: faces may only come from AI images")
    outcome = "reject" if hard else ("needs_review" if warn else "candidate")
    return {"outcome": outcome, "failures": hard, "warnings": warn, "evidence": ev}


def cand_op(d):
    op = d.get("op") or "list"
    with LOCK:
        C = _rj("candidates.json", {"cands": {}})
        if op == "list":
            return {"cands": sorted(C["cands"].values(), key=lambda c: -(c.get("ts") or 0))[:200]}
        if op == "add":
            R = _recipes()["recipes"]
            L = _load()
            valid = set(d.get("ids") or [])
            made = []
            for s in (d.get("suggestions") or [])[:6]:
                if not isinstance(s, dict):
                    continue
                adm = admit(s, R, valid, L["jobs"])
                tgt = str(s.get("target") or "") if str(s.get("type") or "").lower() != "captured" else ""
                base = R.get(tgt)
                cid = "c" + hashlib.sha1(f"{time.time()}{json.dumps(s, ensure_ascii=False)[:500]}".encode()).hexdigest()[:8]
                C["cands"][cid] = {"cid": cid, "ts": time.time(), "type": str(s.get("type") or "").lower(), "target": tgt,
                                   "kind": (base or {}).get("kind") or s.get("kind") or d.get("kind") or "image", "slot": (base or {}).get("slot") or "prompt",
                                   "name": str(s.get("name") or "")[:120], "direction": str(s.get("direction") or "")[:1500],
                                   "summary": str(s.get("change_summary") or "")[:600], "new_text": str(s.get("new_text") or "")[:20000],
                                   "base_vid": (base or {}).get("active"), "base_text": (base["versions"][base["active"]]["text"] if base else ""),
                                   "evidence": adm["evidence"], "admission": {k: adm[k] for k in ("outcome", "failures", "warnings")},
                                   "status": "rejected" if adm["outcome"] == "reject" else "open", "analysis": str(d.get("analysis") or "")[:3000],
                                   "patterns": d.get("patterns") or [], "model": d.get("model"), "cost": d.get("cost"), "as_new": str(s.get("type") or "").lower() == "derived" and bool(s.get("as_new"))}
                made.append(C["cands"][cid])
            _wj("candidates.json", C)
            return {"ok": True, "cands": made}
        c = C["cands"].get(str(d.get("cid") or ""))
        if not c:
            return {"error": "Proposal not found."}
        if op == "reject":
            c["status"] = "rejected"
            c["rejected_by_user"] = True
        elif op == "ab":
            c["status"] = "ab"
            c["ab"] = list(dict.fromkeys((c.get("ab") or []) + [str(x) for x in d.get("jobs") or []]))[:40]
        elif op == "edit":
            c["new_text"] = str(d.get("text") or c["new_text"])[:20000]
            R = _recipes()["recipes"]
            adm = admit({"type": c["type"], "target": c["target"], "new_text": c["new_text"], "evidence": c["evidence"], "direction": c["direction"], "kind": c["kind"]},
                        R, set(c["evidence"]), _load()["jobs"])
            c["admission"] = {k: adm[k] for k in ("outcome", "failures", "warnings")}
            c["status"] = "rejected" if adm["outcome"] == "reject" else ("ab" if c.get("ab") else "open")
        _wj("candidates.json", C)
        return {"ok": True, "cand": c}


# ----------------------------------------------------------------- settings / lessons
DEF_SETTINGS = {"level": 0, "an_model": "", "qc_model": "", "qc_auto": False, "preflight": False, "auto_fix": False,
                "auto_night": False, "auto_hour": 2, "week_cap": 0.5, "auto_min": 3, "inject": False}


def settings(d):
    with LOCK:
        s = dict(DEF_SETTINGS, **_rj("settings.json", {}))
        if d.get("set"):
            for k, v in (d.get("set") or {}).items():
                if k in DEF_SETTINGS:
                    s[k] = v
            s["level"] = max(0, min(2, int(s.get("level") or 0)))
            s["auto_hour"] = max(0, min(23, int(s.get("auto_hour") or 0)))
            s["week_cap"] = max(0.0, min(50.0, float(s.get("week_cap") or 0)))
            s["auto_min"] = max(1, min(50, int(s.get("auto_min") or 3)))
            _wj("settings.json", s)
        return s


def lessons(d):
    with LOCK:
        if d.get("op") == "save":
            items = [x for x in (d.get("lessons") or []) if isinstance(x, dict) and str(x.get("text") or "").strip()][:40]
            for x in items:
                if _has(x.get("text"), EVASION_TERMS) or _has(x.get("text"), EPHEMERAL_TERMS):
                    x["dropped"] = True
            keep = [x for x in items if not x.get("dropped")]
            _wj("lessons.json", {"at": time.time(), "lessons": keep, "model": d.get("model"), "cost": d.get("cost")})
            md = ["# KTOONSTUDIO production lessons (distilled from real results)", f"_Updated {datetime.now().strftime('%d/%m/%Y %H:%M')} — edit this file directly if needed._", ""]
            for k in ("image", "video", "llm", "general"):
                xs = [x for x in keep if (x.get("kind") or "general") == k]
                if xs:
                    md.append({"image": "## Ảnh", "video": "## Video (Seedance)", "llm": "## Script / LLM", "general": "## Chung"}[k])
                    md += [f"- {str(x['text']).strip()}" for x in xs]
                    md.append("")
            return {"ok": True, "markdown": "\n".join(md), "n": len(keep), "dropped": len(items) - len(keep)}
        return _rj("lessons.json", {"lessons": []})


# ================================================================= 4.2.12 · tự động hằng đêm, chèn bài học, chuỗi LLM → ảnh/video
EVO_SYS = "You are the KTOONSTUDIO recipe-evolution analyst (modelled on OpenSpace's skill evolution). A \"recipe\" is a reusable prompt template used to generate AI images, AI videos (Seedance) or LLM text in an AI vertical short-drama studio. You receive an EVIDENCE PACKET: the recipe under review, its statistics, rejected/failed runs and accepted runs, each with the exact prompt sent, the model, errors and the director's verdicts (👍/👎 with reasons and tags, not chosen when regenerated, needed inpaint, kept, reused). Attached images, if any, are outputs the director rejected.\n\n1. Trace why outputs were rejected. Separate causes: (a) the recipe text (missing constraint, ambiguous or conflicting wording, wrong emphasis), (b) the per-node part / inputs (weak reference image, user note), (c) model limits, (d) environment (funds, key, network) — NEVER the recipe's fault, (e) provider content/copyright filters.\n2. Judge from the director's verdicts, not the job status (\"done\" only means the provider returned something).\n3. Propose 0–3 suggestions, each exactly ONE type:\n - \"fix\": the recipe caused repeated rejections or friction → repair it in place, same purpose. target = the recipe id.\n - \"derived\": it works but the evidence shows a better or specialised variant (e.g. the director's own edits to the prompt that got accepted, or a sub-case like night scenes / side profiles needing different instructions). target = parent recipe id; \"as_new\": true if it should be a separate selectable recipe instead of replacing the parent.\n - \"captured\": a reusable pattern from accepted runs with director-written prompts that no existing recipe covers. target = \"\", give a short \"name\"; generalise episode-specific details into reusable wording or {{placeholders}}.\n Prefer ONE precise fix over several vague ones. Return no suggestion when the evidence is thin or the cause is outside the recipe.\n4. Put the COMPLETE new recipe text in \"new_text\" (not a diff). Keep what works, change only what the evidence supports, keep every {{placeholder}} and required marker exactly, keep the original language (usually English). No real-person names, secrets or URLs.\n\nHard rules (proposals breaking them are discarded automatically):\n- NEVER try to get around content moderation or copyright filters (no misspellings, coded words, euphemisms meant to sneak blocked content, \"bypass\"). For blocked runs the only acceptable change makes the content genuinely safer or more original (remove real people / famous characters / copyrighted material, tone down explicit or violent detail) — otherwise leave it to the director.\n- Faces come only from the supplied AI reference images. Anything sensual: adults only, always non-explicit.\n- Cite the EVIDENCE ids supporting every suggestion.\n\nAnswer ONE JSON object only:\n{\"analysis\":\"2–6 sentences in Vietnamese: what goes wrong and why\",\"failure_patterns\":[{\"pattern\":\"short Vietnamese\",\"count\":1,\"cause\":\"recipe|inputs|model|environment|filter\",\"evidence\":[\"ids\"]}],\"suggestions\":[{\"type\":\"fix|derived|captured\",\"target\":\"recipe id or empty\",\"as_new\":false,\"name\":\"\",\"direction\":\"Vietnamese: what to change and why\",\"change_summary\":\"Vietnamese, one line: what changed vs the parent\",\"evidence\":[\"ids\"],\"new_text\":\"full recipe text\"}]}"
EVO_DREAM = "You consolidate production lessons for an AI vertical short-drama studio (AI images, Seedance videos, LLM scripts/shotlists) from an evidence packet of real runs and the director's verdicts. Write 6–20 lessons, each ONE actionable Vietnamese sentence (≤ 30 words) the team or an AI prompt-writer can follow next time: what tends to get rejected and how to write prompts/recipes to avoid it, which settings work best, which content tends to be blocked by providers so prompts can be written SAFER (never how to get around filters). Only patterns seen at least twice or stated by the director. Merge with and update the existing lessons; drop ones contradicted by new evidence. For each lesson that can be written as a direct instruction to an image or video generator, also give \"rule_en\": ONE short English imperative (max 20 words) to append to generation prompts, e.g. \"Keep the exact face identity of the reference image.\" — leave it empty for process/planning lessons. Answer ONE JSON object: {\"lessons\":[{\"kind\":\"image|video|llm|general\",\"text\":\"…\",\"rule_en\":\"… or empty\",\"evidence\":[\"ids\"]}]}"
HOOK = {}
AUTO = {"busy": False}
CHAIN = {}     # hash of an LLM output text → recipe of that LLM run (pictures / videos made from that text inherit it)
RXJ = {}       # job id → rx (this run)


def attach(**kw):
    HOOK.update(kw)
    try:
        _chain_load()
    except Exception as e:
        _log(f"(evo chain: {e})")
    threading.Thread(target=_scheduler, daemon=True).start()


def _log(m):
    try:
        (HOOK.get("log") or print)(m)
    except Exception:
        pass


def _chain_load():
    for e in _lines("evidence.jsonl"):
        if e.get("t") == "start":
            RXJ[e.get("job")] = e.get("rx") or {}
        elif e.get("t") == "end" and e.get("th"):
            rx = RXJ.get(e.get("job")) or {}
            if rx.get("id") and not str(rx["id"]).startswith("free."):
                CHAIN[e["th"]] = {"id": rx["id"], "vid": rx.get("vid") or "", "h": rx.get("h") or "", "via": e.get("job")}


def chain_for(texts):
    for t in texts:
        if isinstance(t, str) and len(t.strip()) > 20:
            hit = CHAIN.get(_h(_norm(t)))
            if hit:
                return hit
    return None


def inject(req):
    """Append the learned prompt rules (lessons with rule_en) to picture / video prompts when the switch is on."""
    try:
        if req.get("kind") not in ("image", "video") or not settings({}).get("inject"):
            return req
        node = str(req.get("node") or "")
        rx = req.get("rx") if isinstance(req.get("rx"), dict) else {}
        if not node or node.startswith("__") or rx.get("ab"):
            return req
        p = str(req.get("prompt") or "")
        have = _norm(p + " " + " ".join(t for t in (req.get("texts") or []) if isinstance(t, str)))
        rules, size = [], 0
        for x in _rj("lessons.json", {}).get("lessons", []):
            r = str(x.get("rule_en") or "").strip()
            if not r or (x.get("kind") or "general") not in (req["kind"], "general") or _norm(r) in have:
                continue
            if _has(r, EVASION_TERMS) or _has(r, EPHEMERAL_TERMS):
                continue
            if size + len(r) > 700 or len(rules) >= 6:
                break
            rules.append(r)
            size += len(r)
        if not rules:
            return req
        block = "Studio rules (learned from the director's past reviews):\n" + "\n".join("- " + r for r in rules)
        return dict(req, prompt=(p.rstrip() + "\n\n" + block) if p.strip() else block, evo_inj=len(rules))
    except Exception:
        return req


def _an_model(s):
    ids = set(HOOK.get("models") or [])
    kf = HOOK.get("keys_fn")
    keys = kf() if callable(kf) else {}
    if s.get("an_model") and s["an_model"] in ids:
        return s["an_model"]
    if "deepseek/deepseek-flash" in ids and keys.get("DEEPSEEK_API_KEY"):
        return "deepseek/deepseek-flash"
    for m in ("openai/gpt-6-luna", "google/gemini-3.6-flash"):
        if m in ids:
            return m
    return next(iter(ids), "")


def _jparse(t):
    t = re.sub(r"^```[a-z]*\s*|```\s*$", "", str(t or "").strip())
    try:
        return json.loads(t)
    except ValueError:
        i, j = t.find("{"), t.rfind("}")
        return json.loads(t[i:j + 1]) if i >= 0 and j > i else {}


def _run_llm(req, timeout=900):
    r = HOOK["start_job"](req)
    if r.get("error"):
        raise RuntimeError(r["error"])
    jid, t0 = r["job"], time.time()
    while time.time() - t0 < timeout:
        time.sleep(2)
        j = (HOOK.get("jobs") or {}).get(jid) or {}
        if j.get("status") and j["status"] != "running":
            if j["status"] != "done":
                raise RuntimeError(str(j.get("error") or j["status"])[:300])
            return (j.get("output") or {}).get("text") or "", float(j.get("cost") or 0), jid
    raise RuntimeError("timed out")


def auto_state():
    A = _rj("auto.json", {"runs": [], "last_day": "", "last_an": {}, "last_dream": 0})
    week = sum(float(r.get("cost") or 0) for r in A.get("runs", []) if (r.get("ts") or 0) > time.time() - 7 * 86400)
    return A, round(week, 4)


def auto_op(d):
    if d.get("op") == "run":
        if AUTO["busy"]:
            return {"error": "Already running."}
        threading.Thread(target=_auto_tick, kwargs={"force": True}, daemon=True).start()
        return {"ok": True}
    A, week = auto_state()
    return {"busy": AUTO["busy"], "week": week, "runs": A.get("runs", [])[-40:], "last_day": A.get("last_day"), "settings": settings({})}


def _scheduler():
    time.sleep(90)
    while True:
        try:
            _auto_tick()
        except Exception as e:
            _log(f"(evo auto: {e})")
        time.sleep(300)


def _auto_tick(force=False):
    s = settings({})
    if not force and not s.get("auto_night"):
        return
    now = datetime.now()
    today = now.strftime("%Y-%m-%d")
    A, week = auto_state()
    if not force and (A.get("last_day") == today or now.hour < int(s.get("auto_hour") or 0)):
        return
    if AUTO["busy"] or not HOOK.get("start_job"):
        return
    AUTO["busy"] = True
    try:
        A["last_day"] = today
        _wj("auto.json", A)
        left = float(s.get("week_cap") or 0) - week
        if left <= 0.0005:
            A["runs"].append({"ts": time.time(), "kind": "skip", "note": f"weekly limit reached ${s.get('week_cap')}"})
            _wj("auto.json", A)
            return
        model = _an_model(s)
        L, R = _load(), _recipes()["recipes"]
        need = []
        for rid in R:
            t0 = (A.get("last_an") or {}).get(rid, 0)
            n = 0
            for j in L["jobs"].values():
                if (j.get("rx") or {}).get("id") != rid or (j.get("ts") or 0) <= t0:
                    continue
                if (j.get("status") == "failed" and j.get("ecls") != "env") or any(o["v"] in ("rej", "fix") for o in j.get("vouts") or []):
                    n += 1
            if n >= int(s.get("auto_min") or 3):
                need.append((n, rid))
        for n, rid in sorted(need, reverse=True)[:5]:
            pk = packet({"rx": rid})
            if pk.get("error"):
                continue
            req = {"kind": "llm", "node": "__evo__", "scope": "evo", "nocore": True, "json_mode": True, "model": model, "system": EVO_SYS,
                   "prompt": pk["text"], "texts": [], "images": [], "extra": ""}
            try:
                est = float(HOOK["estimate"](req))
            except Exception:
                est = 0.01
            if est > left:
                A["runs"].append({"ts": time.time(), "kind": "skip", "rid": rid, "note": f"estimate ${est:.3f} exceeds the remaining limit ${left:.3f}"})
                break
            run = {"ts": time.time(), "kind": "analyze", "rid": rid, "name": R[rid].get("name"), "model": model, "fails": n}
            try:
                text, cost, jid = _run_llm(req)
                left -= cost
                o = _jparse(text)
                res = cand_op({"op": "add", "suggestions": o.get("suggestions") or [], "ids": pk["ids"], "analysis": o.get("analysis") or "",
                               "patterns": o.get("failure_patterns") or [], "model": model, "cost": cost, "kind": R[rid].get("kind")})
                made = res.get("cands") or []
                run.update(cost=cost, job=jid, cands=len(made), ok=sum(1 for c in made if c.get("status") != "rejected"), analysis=str(o.get("analysis") or "")[:300])
                if int(s.get("level") or 0) >= 2:
                    k = 0
                    for c in made:
                        if c.get("type") == "fix" and (c.get("admission") or {}).get("outcome") == "candidate":
                            with LOCK:
                                if recipe_op({"op": "commit", "cid": c["cid"]}).get("ok"):
                                    k += 1
                    run["committed"] = k
            except Exception as e:
                run["err"] = str(e)[:300]
            A.setdefault("last_an", {})[rid] = time.time()
            A["runs"].append(run)
            A["runs"] = A["runs"][-200:]
            _wj("auto.json", A)
            if left <= 0.0005:
                break
        judged = sum(1 for j in L["jobs"].values() if (j.get("ts") or 0) > float(A.get("last_dream") or 0)
                     and any(o["v"] in ("acc", "rej", "fix") for o in j.get("vouts") or []))
        if judged >= 8 and left > 0.0005:
            pk = packet({"mode": "lessons"})
            old = _rj("lessons.json", {}).get("lessons", [])
            req = {"kind": "llm", "node": "__evo__", "scope": "evo", "nocore": True, "json_mode": True, "model": model, "system": EVO_DREAM,
                   "prompt": "EXISTING LESSONS:\n" + ("\n".join(f"- [{x.get('kind')}] {x.get('text')}" for x in old) or "(none)") + "\n\n" + pk.get("text", ""),
                   "texts": [], "images": [], "extra": ""}
            run = {"ts": time.time(), "kind": "dream", "model": model, "judged": judged}
            try:
                est = float(HOOK["estimate"](req))
                if est <= left:
                    text, cost, jid = _run_llm(req)
                    o = _jparse(text)
                    r2 = lessons({"op": "save", "lessons": o.get("lessons") or [], "model": model, "cost": cost})
                    if r2.get("markdown") and HOOK.get("core_save"):
                        HOOK["core_save"](r2["markdown"])
                    run.update(cost=cost, job=jid, lessons=r2.get("n"))
                    A["last_dream"] = time.time()
                else:
                    run.update(kind="skip", note=f"distilling lessons, estimate ${est:.3f} exceeds the remaining limit")
            except Exception as e:
                run["err"] = str(e)[:300]
            A["runs"].append(run)
            _wj("auto.json", A)
        _log(f"Automatic: finished run {today} (~${max(0, left):.3f} left this week)")
    finally:
        AUTO["busy"] = False
