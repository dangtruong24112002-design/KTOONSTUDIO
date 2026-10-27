"""Self-update: poll GitHub for a new commit on main, download+apply it, hand off to a new process on the
next port, roll back the file replace if the new process never comes up healthy. Spec
docs/SPEC_TAP_THU_V2.md §18 (yêu cầu #6). Only touches packaged app files and skill assets listed in CODE_FILES under tap_thu_v2/
— never keys.txt, never anything under DATA_DIR. Test against the fake GitHub API in
ktoon_tap_thu/tests_mock via KTOON_GITHUB_API.

Restart design (deliberately conservative — this runs unattended on the owner's own machine):
the OLD process keeps serving on its own port throughout. It backs up the current code files, applies the
downloaded ones, then spawns a NEW process pointed at the next port and health-checks it for up to
HEALTH_TIMEOUT seconds. Only once the new process answers do we tell the frontend where to go and let the
old process exit — so a failed update never touches whatever is already running. If the new process never
comes up, we kill it, restore the backup, and keep serving on the old process exactly as before; nothing
about the running app is ever disturbed by a failed attempt.
"""
import io
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

import pipeline as P

HERE = P.HERE
GITHUB_API = os.environ.get("KTOON_GITHUB_API", "https://api.github.com")
DEFAULT_REPO = "dangtruong24112002-design/KTOONSTUDIO"
CODE_FILES = ["app.py", "pipeline.py", "providers.py", "updater.py", "ui.html",
              "skills/video-editing/SKILL.md", "skills/video-editing/LICENSE.txt"]
VERSION_FILE = HERE / ".version.json"
BACKUP_DIR = HERE / ".update_backup"
CHECK_INTERVAL = float(os.environ.get("KTOON_UPDATE_INTERVAL", "120"))
HEALTH_TIMEOUT = float(os.environ.get("KTOON_UPDATE_HEALTH_TIMEOUT", "20"))

_lock = threading.Lock()
_busy = False


def current_version():
    if VERSION_FILE.exists():
        try:
            return json.loads(VERSION_FILE.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pass
    return {"sha": "", "t": ""}


def _write_version(sha, t=None):
    VERSION_FILE.write_text(json.dumps({"sha": sha, "t": t or P.ts()}), encoding="utf-8")


def github_repo():
    return (P.KEYS.get("GITHUB_REPO") or "").strip() or DEFAULT_REPO


def _github_token():
    return (P.KEYS.get("GITHUB_TOKEN") or "").strip()


def _github_request(path, raw=False, timeout=30):
    req = urllib.request.Request(GITHUB_API + path, headers={
        "User-Agent": "ktoonstudio-tapthu-v2-updater/1.0",
        "Accept": "application/octet-stream" if raw else "application/vnd.github+json",
    })
    tok = _github_token()
    if tok:
        req.add_header("Authorization", "Bearer " + tok)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read() if raw else json.loads(r.read().decode("utf-8"))


def latest_main_commit():
    """(sha, committer_date) for the tip of main, or raises on any network/API error."""
    data = _github_request(f"/repos/{github_repo()}/commits/main")
    sha = data.get("sha") or ""
    if not sha:
        raise ValueError("GitHub không trả về sha.")
    commit = data.get("commit") or {}
    when = ((commit.get("committer") or commit.get("author") or {}).get("date")) or ""
    return sha, when


def _extract_code_files(zip_bytes):
    """{relative_path: bytes} for packaged files below tap_thu_v2/ in the zipball."""
    out = {}
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as z:
        for name in z.namelist():
            parts = name.split("/")
            try:
                app_index = parts.index("tap_thu_v2")
            except ValueError:
                continue
            relative = "/".join(parts[app_index + 1:])
            if relative in CODE_FILES:
                out[relative] = z.read(name)
    return out


def _backup_current():
    if BACKUP_DIR.exists():
        shutil.rmtree(BACKUP_DIR)
    BACKUP_DIR.mkdir(parents=True)
    for name in CODE_FILES:
        p = HERE / name
        if p.exists():
            backup = BACKUP_DIR / name
            backup.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, backup)


def _restore_backup():
    for name in CODE_FILES:
        b = BACKUP_DIR / name
        target = HERE / name
        if b.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(b, target)
        elif target.exists():
            target.unlink()


def _apply_files(files):
    for name, data in files.items():
        target = HERE / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)


def jobs_mid_submit():
    """True while any job is between 'submitting' and having a pid — the exact unsafe window the
    existing resume logic (app.py main()) also treats specially. Never restart during this window."""
    return any(j["status"] == "running" and not j.get("pid") for j in P.STATE["jobs"].values())


def _health_check(port, timeout):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=2) as r:
                if r.status == 200:
                    return True
        except Exception:
            pass
        time.sleep(0.5)
    return False


def _spawn_new_process(port):
    env = dict(os.environ)
    env["KTOON_PORT"] = str(port)
    env["KTOON_NO_BROWSER"] = "1"
    kwargs = {}
    if sys.platform == "win32":
        kwargs["creationflags"] = subprocess.CREATE_NEW_CONSOLE
    else:
        kwargs["start_new_session"] = True
    return subprocess.Popen([sys.executable, str(HERE / "app.py")], cwd=str(HERE), env=env, **kwargs)


def status():
    with _lock:
        busy = _busy
    return {"version": current_version(), "checking": busy,
            "state": dict(P.STATE.get("update_status") or {})}


def check_and_apply(current_port, force=False):
    """Runs on the poller thread (or the "Kiểm tra ngay" button, via a background thread so the HTTP
    handler doesn't block on it). Returns a short Vietnamese status string; never raises."""
    global _busy
    with _lock:
        if _busy:
            return "Đang kiểm tra rồi."
        _busy = True
    try:
        try:
            sha, when = latest_main_commit()
        except Exception as e:
            P.log(f"Không hỏi được GitHub để kiểm tra cập nhật: {P.scrub(str(e))}")
            return f"Không hỏi được GitHub: {e}"
        cur = current_version()
        missing_local = [name for name in CODE_FILES if not (HERE / name).is_file()]
        if not cur.get("sha") and not missing_local:
            _write_version(sha, when)
            return "Đã ghi nhận phiên bản hiện tại (lần đầu chạy)."
        if sha == cur.get("sha") and not missing_local:
            return "Đã là bản mới nhất."
        if missing_local:
            P.log(f"Thiếu file app {missing_local} — sẽ đồng bộ lại gói hiện tại.")
        if not force and jobs_mid_submit():
            return "Có việc đang gửi — chờ đợt kiểm tra sau (2 phút) để không cắt ngang."
        P.log(f"Cập nhật: có commit mới {sha[:7]} trên GitHub, đang tải…")
        try:
            zip_bytes = _github_request(f"/repos/{github_repo()}/zipball/{sha}", raw=True, timeout=120)
            files = _extract_code_files(zip_bytes)
        except Exception as e:
            P.log(f"Tải bản mới thất bại: {P.scrub(str(e))}")
            return f"Tải bản mới thất bại: {e}"
        missing = [n for n in CODE_FILES if n not in files]
        if missing:
            P.log(f"Bản zip thiếu file {missing} — huỷ cập nhật.")
            return f"Bản zip thiếu file {missing} — huỷ cập nhật."
        _backup_current()
        _apply_files(files)
        new_port = current_port + 1
        P.log(f"Đã thay file code sang {sha[:7]}, đang mở tiến trình mới ở cổng {new_port}…")
        proc = _spawn_new_process(new_port)
        healthy = _health_check(new_port, HEALTH_TIMEOUT)
        if healthy:
            _write_version(sha, when)
            with P.LOCK:
                P.STATE["update_status"] = {"applied": {"sha": sha, "t": P.ts(), "new_port": new_port}}
            P.save()
            P.log(f"Cập nhật xong — tiến trình mới ({sha[:7]}) đang chạy ở cổng {new_port}. Tiến trình cũ sẽ tự tắt.")
            threading.Thread(target=_exit_after_handoff, daemon=True).start()
            return f"Đã cập nhật lên {sha[:7]} — mở lại trang để chuyển sang bản mới."
        P.log(f"Bản mới không mở được server trong {HEALTH_TIMEOUT:.0f}s — đang quay lại bản cũ.")
        try:
            proc.terminate()
        except Exception:
            pass
        _restore_backup()
        with P.LOCK:
            P.STATE["update_status"] = {"rollback": {"from": sha, "to": cur.get("sha", ""), "t": P.ts(),
                "msg": f"Bản mới ({sha[:7]}) không mở được server trong {HEALTH_TIMEOUT:.0f}s — đã tự quay lại bản cũ. File code đã khôi phục; app đang tiếp tục chạy bản cũ không gián đoạn."}}
        P.save()
        return "Bản mới lỗi — đã quay lại bản cũ, app vẫn đang chạy bình thường."
    finally:
        with _lock:
            _busy = False


def _exit_after_handoff():
    """Give the frontend a few seconds to read update_status.applied and redirect, then let this
    process exit — the new process is already independently serving by this point."""
    time.sleep(6)
    P.log("Tiến trình cũ tắt sau khi bàn giao cho bản mới.")
    os._exit(0)


def start_poller(port):
    def loop():
        # first check on startup establishes the baseline without trying to "update" onto itself
        time.sleep(5)
        while True:
            try:
                check_and_apply(port)
            except Exception as e:
                P.log(f"Lỗi vòng kiểm tra cập nhật (không dừng app): {P.scrub(str(e))}")
            time.sleep(CHECK_INTERVAL)
    threading.Thread(target=loop, daemon=True).start()
