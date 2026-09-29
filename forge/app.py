#!/usr/bin/env python3
"""KTOONSTUDIO · forge — Giai đoạn 1 (Lõi sản xuất) của brief "Tool gen video AI tối ưu".

Bấm đúp chay_forge.bat: app mở giao diện trên trình duyệt. Key đọc từ forge\\keys.txt, hoặc
~/.ktoon/keys.txt nếu không có — không bao giờ gửi ra trình duyệt hay ghi vào file khác.
Chỉ dùng thư viện có sẵn của Python 3.8 trở lên.
"""
import json
import secrets
import sys
import threading
import traceback
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

import pipeline as P
from pipeline import HERE, OUT, STATE, KEYS, LOCK, RUNNING

TOKEN = __import__("os").environ.get("KTOON_TEST_TOKEN") or secrets.token_urlsafe(18)
PORT = [8940]
NO_BROWSER = __import__("os").environ.get("KTOON_NO_BROWSER") == "1"

CTYPES = {".html": "text/html; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
          ".webp": "image/webp", ".mp4": "video/mp4", ".csv": "text/csv; charset=utf-8",
          ".txt": "text/plain; charset=utf-8", ".json": "application/json; charset=utf-8"}


class QuietServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        if not isinstance(sys.exc_info()[1], (ConnectionError, TimeoutError)):
            super().handle_error(request, client_address)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _host_ok(self):
        return self.headers.get("Host", "") in (f"127.0.0.1:{PORT[0]}", f"localhost:{PORT[0]}")

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _file(self, path):
        size = path.stat().st_size
        ctype = CTYPES.get(path.suffix.lower(), "application/octet-stream")
        start, end = 0, size - 1
        rng = self.headers.get("Range", "")
        if rng.startswith("bytes=") and size:
            a, _, b = rng[6:].split(",")[0].partition("-")
            try:
                if a.strip():
                    start = int(a)
                    end = int(b) if b.strip() else size - 1
                else:
                    start = max(0, size - int(b))
            except ValueError:
                start, end = 0, size - 1
            end = min(end, size - 1)
            if start > end:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            self.send_response(200)
        length = max(0, end - start + 1)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        with open(path, "rb") as f:
            f.seek(start)
            left = length
            while left > 0:
                chunk = f.read(min(1 << 16, left))
                if not chunk:
                    break
                self.wfile.write(chunk)
                left -= len(chunk)

    def do_GET(self):
        if not self._host_ok():
            return self._send(403, {"error": "host"})
        path = unquote(urlparse(self.path).path)
        try:
            if path == "/favicon.ico":
                self.send_response(204)
                self.end_headers()
                return
            if path in ("/", "/index.html"):
                page = (HERE / "ui.html").read_text(encoding="utf-8").replace("__FORGE_TOKEN__", TOKEN)
                return self._send(200, page, "text/html; charset=utf-8")
            if path == "/api/state":
                if self.headers.get("X-Forge-Token") != TOKEN:
                    return self._send(403, {"error": "token"})
                return self._send(200, P.public_state())
            if path.startswith("/files/"):
                rel = path[len("/files/"):]
                target = (OUT / rel).resolve()
                if OUT.resolve() not in target.parents or not target.is_file():
                    return self._send(404, {"error": "không có file"})
                return self._file(target)
            return self._send(404, {"error": "không có"})
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def do_POST(self):
        if not self._host_ok() or self.headers.get("X-Forge-Token") != TOKEN:
            return self._send(403, {"error": "Phiên không hợp lệ — tải lại trang."})
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        try:
            if path == "/api/asset/upload":
                return self._send(200, self.upload_asset(parse_qs(parsed.query), raw))
            data = json.loads(raw.decode("utf-8") or "{}")
            return self._send(200, self.route(path, data))
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except Exception as e:
            P.log(traceback.format_exc())
            return self._send(200, {"error": P.scrub(str(e))})

    def upload_asset(self, q, raw):
        def one(k, d=""):
            return (q.get(k) or [d])[0]
        sid, kind, name, ext = one("series"), one("kind"), one("name"), one("ext", ".jpg")
        if not raw:
            return {"error": "Chưa chọn file."}
        try:
            a = P.new_asset(sid, kind, name, raw, ext)
            return {"ok": True, "asset": a}
        except (ValueError, P.ApiError) as e:
            return {"error": str(e)}

    def route(self, path, d):
        try:
            return self._route(path, d)
        except (ValueError, P.ApiError) as e:
            return {"error": str(e)}

    def _route(self, path, d):
        if path == "/api/series/new":
            s = P.new_series(d.get("code"), d.get("name"), d.get("budget_usd") or 40.0)
            return {"ok": True, "series": s}
        if path == "/api/series/select":
            P.set_active_series(d.get("id"))
            return {"ok": True}
        if path == "/api/series/bible":
            P.update_bible(d.get("id"), d)
            return {"ok": True}
        if path == "/api/series/budget":
            P.set_series_budget(d.get("id"), d.get("budget_usd"))
            return {"ok": True}
        if path == "/api/asset/remove":
            P.remove_asset(d.get("id"))
            return {"ok": True}
        if path == "/api/episode/new":
            e = P.new_episode(d.get("series_id"), d.get("code"), d.get("name"))
            return {"ok": True, "episode": e}
        if path == "/api/sequence/new":
            s = P.new_sequence(d.get("episode_id"), d.get("duration_s") or 15, d.get("model_id"),
                               d.get("aspect") or "9:16", d.get("overview") or "")
            return {"ok": True, "sequence": s}
        if path == "/api/sequence/update":
            P.update_sequence(d.get("id"), d)
            return {"ok": True}
        if path == "/api/shot/new":
            s = P.new_shot(d.get("sequence_id"), d.get("start_s") or 0, d.get("end_s") or 4)
            return {"ok": True, "shot": s}
        if path == "/api/shot/update":
            P.update_shot(d.get("id"), d)
            return {"ok": True}
        if path == "/api/shot/remove":
            P.remove_shot(d.get("id"))
            return {"ok": True}
        if path == "/api/compile_preview":
            seqid = d.get("sequence_id")
            prompt, used_ids = P.compile_prompt(seqid)
            errors = P.preflight(seqid)
            return {"ok": True, "prompt": prompt, "asset_ids": used_ids, "errors": errors}
        if path == "/api/render/run":
            return P.create_render(d.get("sequence_id"), bool(d.get("redo")), bool(d.get("dry")))
        if path == "/api/render/verdict":
            P.set_render_verdict(d.get("job_id"), d.get("verdict") or "", d.get("reason") or "")
            return {"ok": True}
        return {"error": "Không có route " + path}


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "assets").mkdir(exist_ok=True)
    (OUT / "renders").mkdir(exist_ok=True)
    P.ensure_keys_file()
    KEYS.update(P.load_keys())
    STATE.update(P.load_state())
    resume = []
    for j in STATE["jobs"].values():
        if j["status"] in ("queued", "starting"):
            j.update(status="cancelled", error="App tắt trước khi gửi — không tốn tiền. Bấm chạy lại nếu cần.")
        elif j["status"] == "running" and not j.get("pid"):
            j.update(status="failed", cost=j.get("cost", 0),
                     error="App tắt đúng lúc đang gửi — có thể đã bị tính tiền, kiểm tra console nhà cung cấp.")
        elif j["status"] in ("running", "stalled") and j.get("pid"):
            j["status"] = "starting"
            resume.append(j["id"])
    P.save()
    srv = None
    port0 = int(__import__("os").environ.get("KTOON_PORT", "8940"))
    for port in range(port0, port0 + 40):
        try:
            srv = QuietServer(("127.0.0.1", port), Handler)
            PORT[0] = port
            break
        except OSError:
            continue
    if not srv:
        print("Không mở được cổng mạng nội bộ.")
        sys.exit(1)
    for jid in resume:
        RUNNING.add(jid)
        threading.Thread(target=P.run_job, args=(jid,), daemon=True).start()
    threading.Thread(target=P.scheduler, daemon=True).start()
    threading.Thread(target=P.refresh_balances, daemon=True).start()
    url = f"http://127.0.0.1:{PORT[0]}/"
    have = ", ".join(P.PROVIDER_NAME[p] for p, k in P.KEY_OF.items() if KEYS.get(k)) or "chưa có key nào"
    P.log(f"forge (Giai đoạn 1) · key: {have}")
    P.log(f"Giao diện: {url}   (giữ cửa sổ này mở; đóng cửa sổ là tắt app, việc đang chạy sẽ tiếp tục lần sau)")
    if not NO_BROWSER:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    srv.serve_forever()


if __name__ == "__main__":
    main()
