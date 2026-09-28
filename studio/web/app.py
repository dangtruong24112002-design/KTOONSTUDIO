"""Local dashboard: FastAPI + Jinja2 + HTMX. Owner-facing text is Vietnamese.

Screens so far (M1): home (script in -> analyse -> episodes + shot list, Gate 1, money box),
asset registry, cost ledger.
"""
from __future__ import annotations

import re
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Form, Request, UploadFile
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from studio import config
from studio.core import budget, db, registry
from studio.roles import development

HERE = Path(__file__).resolve().parent
PROJECT = config.DEFAULT_PROJECT
MAX_UPLOAD_BYTES = 20 * 1024 * 1024



@asynccontextmanager
async def lifespan(_app: FastAPI):
    with db.session() as conn:
        registry.get_project(conn, PROJECT)
        budget.ensure_scopes(conn)
        budget.import_m0_log(conn)
    yield


app = FastAPI(title="Studio OS", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=HERE / "static"), name="static")
templates = Jinja2Templates(directory=HERE / "templates")
templates.env.filters["loads"] = lambda s: db.loads(s, [])

EP_STATUS_VI = {"draft": "Nháp", "shotlist_ready": "Chờ duyệt Cổng 1", "gate1_approved": "Đã duyệt Cổng 1",
                "gate1_rejected": "Bị trả lại"}
ASSET_STATUS_VI = {"draft": "Nháp", "approved": "Đã duyệt", "locked": "Đã khóa"}
templates.env.globals.update(EP_STATUS_VI=EP_STATUS_VI, ASSET_STATUS_VI=ASSET_STATUS_VI)


# ---------------------------------------------------------------- helpers

def _scripts_ctx() -> dict:
    files = development.list_script_files(PROJECT)
    return {"files": [{"name": f.name, "kb": max(1, f.stat().st_size // 1024),
                       "mtime": time.strftime("%d/%m %H:%M", time.localtime(f.stat().st_mtime))} for f in files],
            "folder": str(config.project_dir(PROJECT) / "01_kich_ban")}


def _episodes_ctx(conn) -> dict:
    pid = registry.get_project(conn, PROJECT)["id"]
    eps = conn.execute(
        "SELECT e.*, count(s.id) AS n_shots, coalesce(sum(s.duration_s), 0) AS secs"
        " FROM episode e LEFT JOIN shot s ON s.episode_id = e.id WHERE e.project_id = ?"
        " GROUP BY e.id ORDER BY e.number", (pid,)).fetchall()
    return {"episodes": eps}


def _shots_ctx(conn, episode_id: int) -> dict:
    ep = conn.execute("SELECT * FROM episode WHERE id = ?", (episode_id,)).fetchone()
    shots = conn.execute(
        'SELECT s.*, l.code AS loc_code, l.name AS loc_name FROM shot s LEFT JOIN location l ON l.id = s.location_id'
        ' WHERE s.episode_id = ? ORDER BY "order"', (episode_id,)).fetchall()
    names = {r["code"]: r["name"] for r in conn.execute(
        "SELECT code, name FROM character WHERE project_id = ?", (ep["project_id"],)).fetchall()}
    last_gate = conn.execute("SELECT * FROM approval WHERE gate = 1 AND target_id = ? ORDER BY id DESC LIMIT 1",
                             (str(episode_id),)).fetchone()
    return {"ep": ep, "shots": shots, "char_names": names, "last_gate": last_gate,
            "json_path": f"data/projects/{PROJECT}/02_shotlist/EP{ep['number']:02d}_shotlist.json"}


def _safe_name(name: str) -> str:
    stem, ext = Path(name).stem, Path(name).suffix.lower()
    stem = re.sub(r"[^\w\-. ]", "_", stem, flags=re.UNICODE).strip(" .") or "kich_ban"
    return f"{stem[:80]}{ext}"


# ---------------------------------------------------------------- pages

@app.get("/", response_class=HTMLResponse)
def home(request: Request):
    with db.session() as conn:
        ctx = {"spend": budget.summary(conn), **_scripts_ctx(), **_episodes_ctx(conn)}
    return templates.TemplateResponse(request, "index.html", ctx)


@app.get("/spend", response_class=HTMLResponse)
def spend_box(request: Request):
    with db.session() as conn:
        return templates.TemplateResponse(request, "_spend.html", {"spend": budget.summary(conn)})


@app.post("/upload", response_class=HTMLResponse)
async def upload(request: Request, files: list[UploadFile] | None = None, pasted: str = Form(""),
                 pasted_name: str = Form("")):
    folder = config.project_dir(PROJECT) / "01_kich_ban"
    msgs, errors = [], []
    for f in files or []:
        if not f.filename:
            continue
        name = _safe_name(f.filename)
        if Path(name).suffix not in development.SCRIPT_EXTS:
            errors.append(f"{f.filename}: chỉ nhận .txt .md .docx .pdf")
            continue
        data = await f.read()
        if len(data) > MAX_UPLOAD_BYTES:
            errors.append(f"{f.filename}: file quá lớn (tối đa 20 MB)")
            continue
        (folder / name).write_bytes(data)
        msgs.append(f"Đã lưu {name}")
    if pasted.strip():
        name = _safe_name((pasted_name.strip() or f"dan_{time.strftime('%Y%m%d_%H%M%S')}") + ".txt")
        (folder / name).write_text(pasted, encoding="utf-8")
        msgs.append(f"Đã lưu đoạn chữ vào {name}")
    if not msgs and not errors:
        errors.append("Chưa có file hay đoạn chữ nào.")
    return templates.TemplateResponse(request, "_scripts.html", {**_scripts_ctx(), "msgs": msgs, "errors": errors})


@app.post("/analyze", response_class=HTMLResponse)
def analyze(request: Request, filename: str = Form(...)):
    path = config.project_dir(PROJECT) / "01_kich_ban" / Path(filename).name
    msgs, errors, warnings = [], [], []
    with db.session() as conn:
        if not path.exists():
            errors.append(f"Không thấy file {filename}.")
        else:
            try:
                a = development.analyze_file(conn, path, PROJECT)
                n_shots = sum(len(e.shots) for e in a.episodes)
                msgs.append(f"Đã phân tích {path.name}: {len(a.episodes)} tập, {n_shots} shot, "
                            f"{len(a.characters)} nhân vật, {len(a.locations)} bối cảnh. Chi phí: 0 USD (phân tích offline).")
                warnings = a.warnings
            except development.Locked as ex:
                errors.append(str(ex))
            except Exception as ex:  # show the owner something readable, keep the app alive
                errors.append(f"Không đọc được {path.name}: {ex}")
        ctx = {**_episodes_ctx(conn), "msgs": msgs, "errors": errors, "warnings": warnings}
    resp = templates.TemplateResponse(request, "_episodes.html", ctx)
    resp.headers["HX-Trigger"] = "spend-changed"
    return resp


@app.get("/episode/{episode_id}", response_class=HTMLResponse)
def episode_shots(request: Request, episode_id: int):
    with db.session() as conn:
        return templates.TemplateResponse(request, "_shots.html", _shots_ctx(conn, episode_id))


@app.post("/episode/{episode_id}/gate1", response_class=HTMLResponse)
def gate1(request: Request, episode_id: int, decision: str = Form(...), note: str = Form("")):
    if decision not in ("approved", "rejected"):
        decision = "rejected"
    with db.session() as conn:
        conn.execute("INSERT INTO approval(gate, target_id, status, note, ts) VALUES (1, ?, ?, ?, ?)",
                     (str(episode_id), decision, note.strip(), time.strftime("%Y-%m-%dT%H:%M:%S")))
        conn.execute("UPDATE episode SET status = ? WHERE id = ?", (f"gate1_{decision}", episode_id))
        development.export_shotlist(conn, episode_id, PROJECT)
        ctx = _shots_ctx(conn, episode_id)
    resp = templates.TemplateResponse(request, "_shots.html", ctx)
    resp.headers["HX-Trigger"] = "episodes-changed"
    return resp


@app.get("/episodes", response_class=HTMLResponse)
def episodes_panel(request: Request):
    with db.session() as conn:
        return templates.TemplateResponse(request, "_episodes.html", _episodes_ctx(conn))


@app.get("/kho", response_class=HTMLResponse)
def kho(request: Request):
    with db.session() as conn:
        pid = registry.get_project(conn, PROJECT)["id"]
        ctx = {"assets": registry.list_all(conn, pid), "usage": registry.usage_counts(conn, pid),
               "spend": budget.summary(conn), "folder": str(config.project_dir(PROJECT) / "00_kho")}
    return templates.TemplateResponse(request, "kho.html", ctx)


@app.post("/kho/{table}/{asset_id}", response_class=HTMLResponse)
def kho_save(request: Request, table: str, asset_id: int, name: str = Form(...), canon_description: str = Form(""),
             rules: str = Form(""), status: str = Form("draft")):
    if table not in registry.TABLES:
        return HTMLResponse("Sai loại tài nguyên", status_code=400)
    with db.session() as conn:
        registry.update(conn, table, asset_id, {"name": name.strip() or "?", "canon_description": canon_description,
                                                 "rules": rules, "status": status})
        row = conn.execute(f"SELECT * FROM {table} WHERE id = ?", (asset_id,)).fetchone()
        usage = registry.usage_counts(conn, row["project_id"])
    return templates.TemplateResponse(request, "_asset.html", {"a": row, "table": table, "usage": usage, "saved": True})


@app.get("/so-chi", response_class=HTMLResponse)
def ledger(request: Request):
    with db.session() as conn:
        rows = conn.execute("SELECT * FROM generation_log ORDER BY ts DESC LIMIT 500").fetchall()
        ctx = {"rows": rows, "spend": budget.summary(conn),
               "scopes": conn.execute("SELECT * FROM budget ORDER BY scope").fetchall()}
    return templates.TemplateResponse(request, "so_chi.html", ctx)


@app.get("/favicon.ico")
def favicon():
    return RedirectResponse("/static/favicon.svg")
