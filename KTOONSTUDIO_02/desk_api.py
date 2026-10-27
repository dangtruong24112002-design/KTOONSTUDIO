"""KTOONSTUDIO Desk — quản lý dự án (workspace node, task, lịch, báo giá) chạy trong app.

Dữ liệu: data/desk/db.json  ({"rev": n, "colls": {tên_bộ: {id: tài_liệu}}})
Tệp:     data/desk/files/<id>.<đuôi>
Sao lưu: data/desk/backup/db_YYYYMMDD.json (1 bản / ngày, giữ 60 ngày)
"""
import json
import os
import re
import secrets
import shutil
import threading
import time
from datetime import datetime
from pathlib import Path

LOCK = threading.Lock()
_ST = {"dir": None, "db": None}
_COLL = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
_ID = re.compile(r"^[A-Za-z0-9_.:@+~-]{1,200}$")
_FID = re.compile(r"^[0-9a-f]{16,32}$")
MAX_DOC = 1_000_000
MAX_FILE = 500 * 1024 * 1024


def init(data_dir):
    d = Path(data_dir) / "desk"
    (d / "files").mkdir(parents=True, exist_ok=True)
    (d / "backup").mkdir(parents=True, exist_ok=True)
    _ST["dir"] = d


def _path():
    return _ST["dir"] / "db.json"


def _load():
    if _ST["db"] is not None:
        return _ST["db"]
    p = _path()
    db = {"rev": 0, "colls": {}}
    if p.is_file():
        try:
            j = json.loads(p.read_text(encoding="utf-8"))
            if isinstance(j, dict) and isinstance(j.get("colls"), dict):
                db = {"rev": int(j.get("rev") or 0), "colls": j["colls"]}
        except Exception:
            bad = p.with_name(f"db.broken_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json")
            shutil.copyfile(p, bad)
    _ST["db"] = db
    return db


def _save(db):
    d = _ST["dir"]
    bk = d / "backup" / f"db_{datetime.now().strftime('%Y%m%d')}.json"
    if _path().is_file() and not bk.exists():
        shutil.copyfile(_path(), bk)
        olds = sorted((d / "backup").glob("db_*.json"))
        for o in olds[:-60]:
            try:
                o.unlink()
            except OSError:
                pass
    tmp = d / "db.tmp"
    tmp.write_text(json.dumps(db, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, _path())


def all_():
    with LOCK:
        db = _load()
        return {"rev": db["rev"], "colls": db["colls"]}


def rev():
    with LOCK:
        return {"rev": _load()["rev"]}


def put(req):
    coll, did, doc = str(req.get("coll") or ""), str(req.get("id") or ""), req.get("doc")
    if not _COLL.match(coll) or not _ID.match(did):
        return {"error": "Invalid collection name or id."}
    if doc is not None and not isinstance(doc, dict):
        return {"error": "The document must be an object."}
    if doc is not None and len(json.dumps(doc, ensure_ascii=False)) > MAX_DOC:
        return {"error": "The document is too large (> 1 MB)."}
    with LOCK:
        db = _load()
        c = db["colls"].setdefault(coll, {})
        if doc is None:
            c.pop(did, None)
        else:
            c[did] = doc
        db["rev"] += 1
        _save(db)
        return {"ok": True, "rev": db["rev"]}


def batch(req):
    ops = req.get("ops") or []
    if not isinstance(ops, list) or len(ops) > 500:
        return {"error": "Invalid ops."}
    with LOCK:
        db = _load()
        for o in ops:
            coll, did, doc = str(o.get("coll") or ""), str(o.get("id") or ""), o.get("doc")
            if not _COLL.match(coll) or not _ID.match(did) or (doc is not None and not isinstance(doc, dict)):
                return {"error": f"Invalid operation: {coll}/{did}"}
        for o in ops:
            c = db["colls"].setdefault(o["coll"], {})
            if o.get("doc") is None:
                c.pop(o["id"], None)
            else:
                c[o["id"]] = o["doc"]
        db["rev"] += 1
        _save(db)
        return {"ok": True, "rev": db["rev"]}


def upload(name, raw):
    if not raw:
        return {"error": "Empty file."}
    if len(raw) > MAX_FILE:
        return {"error": "The file is larger than 500 MB."}
    ext = Path(name or "").suffix.lower()
    if not re.match(r"^\.[a-z0-9]{1,8}$", ext):
        ext = ".bin"
    fid = secrets.token_hex(16)
    p = _ST["dir"] / "files" / f"{fid}{ext}"
    p.write_bytes(raw)
    return {"id": fid, "url": f"/_blob/{fid}", "sizeBytes": len(raw), "contentType": ext[1:]}


def blob_path(fid):
    fid = (fid or "").split("/")[0].split(".")[0]
    if not _FID.match(fid):
        return None
    for p in (_ST["dir"] / "files").glob(fid + ".*"):
        if p.is_file():
            return p
    return None


def delfile(req):
    p = blob_path(str(req.get("id") or ""))
    if not p:
        return {"ok": True}
    tr = _ST["dir"] / "trash"
    tr.mkdir(exist_ok=True)
    shutil.move(str(p), str(tr / p.name))       # giữ trong data/desk/trash, không xoá hẳn
    return {"ok": True}
