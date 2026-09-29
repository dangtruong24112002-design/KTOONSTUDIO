#!/usr/bin/env python3
"""KTOONSTUDIO · tap1 — bản tối giản (yêu cầu #8): 1 trang, 3 bước, dự án "The Alpha", 1 tập (EP01).

Bấm đúp chay_tap1.bat: app mở giao diện trên trình duyệt. Key đọc từ tap1\\keys.txt, hoặc
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
PORT = [8891]
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
                page = (HERE / "ui.html").read_text(encoding="utf-8").replace("__TAP1_TOKEN__", TOKEN)
                return self._send(200, page, "text/html; charset=utf-8")
            if path == "/api/state":
                if self.headers.get("X-Tap1-Token") != TOKEN:
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
        if not self._host_ok() or self.headers.get("X-Tap1-Token") != TOKEN:
            return self._send(403, {"error": "Phiên không hợp lệ — tải lại trang."})
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        try:
            if path == "/api/char/upload_image":
                return self._send(200, self.upload_char_image(parse_qs(parsed.query), raw))
            data = json.loads(raw.decode("utf-8") or "{}")
            return self._send(200, self.route(path, data))
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except Exception as e:
            P.log(traceback.format_exc())
            return self._send(200, {"error": P.scrub(str(e))})

    def upload_char_image(self, q, raw):
        cid = (q.get("char") or [""])[0]
        ext = (q.get("ext") or [".jpg"])[0]
        if cid not in STATE["chars"]:
            return {"error": "Không có nhân vật này."}
        if not raw:
            return {"error": "Chưa chọn file."}
        name = STATE["chars"][cid]["name"]
        dest = OUT / "characters" / f"{P.PROJECT_SLUG}_{P.slug(name)}_upload{ext}"
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(raw)
        job = P.register_local("char_gen", cid, dest)
        return {"ok": True, "job": job["id"]}

    def route(self, path, d):
        try:
            return self._route(path, d)
        except (ValueError, P.ApiError) as e:
            return {"error": str(e)}

    def _route(self, path, d):
        if path == "/api/run":
            return P.create_jobs(d.get("stage"), d.get("target") or None, bool(d.get("redo")), bool(d.get("dry")))
        if path == "/api/profiles":
            with LOCK:
                STATE["profiles_raw"] = str(d.get("text") or "")
            P.save()
            return {"ok": True}
        if path == "/api/char_tpl":
            with LOCK:
                STATE["char_tpl"] = str(d.get("text") or "")
            P.save()
            return {"ok": True}
        if path == "/api/shotlist":
            with LOCK:
                STATE["shotlist_raw"] = str(d.get("text") or "")
            P.save()
            return {"ok": True}
        if path == "/api/video_tpl":
            with LOCK:
                STATE["video_tpl"] = str(d.get("text") or "")
            P.save()
            return {"ok": True}
        if path == "/api/settings":
            model = str(d.get("llm_model") or "")
            if model and model not in P.LLM_PRICE:
                return {"error": "Model LLM không hợp lệ."}
            if model:
                with LOCK:
                    STATE["settings"]["llm_model"] = model
                P.save()
            return {"ok": True}
        if path == "/api/char/prompt":
            P.set_char_prompt(d.get("id"), str(d.get("text") or ""))
            return {"ok": True}
        if path == "/api/char/approve":
            P.set_char_approved(d.get("id"), bool(d.get("approved")))
            return {"ok": True}
        if path == "/api/batch/prompt":
            P.set_batch_prompt(d.get("id"), str(d.get("text") or ""))
            return {"ok": True}
        if path == "/api/batch/model":
            P.set_batch_model(d.get("id"), str(d.get("model") or ""))
            return {"ok": True}
        return {"error": "Không có route " + path}


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "characters").mkdir(exist_ok=True)
    P.ensure_keys_file()
    KEYS.update(P.load_keys())
    STATE.update(P.load_state())
    resume = []
    for j in STATE["jobs"].values():
        if j["status"] in ("queued", "starting"):
            j.update(status="cancelled", error="App tắt trước khi gửi — không tốn tiền. Bấm chạy lại nếu cần.")
        elif j["status"] == "running" and not j.get("pid"):
            if j["kind"] in P.LLM_KINDS:
                j.update(status="failed", error="App tắt khi đang chờ model trả lời. Bấm chạy lại.")
            else:
                j.update(status="failed", cost=j.get("cost", 0),
                         error="App tắt đúng lúc đang gửi — có thể đã bị tính tiền, kiểm tra console nhà cung cấp.")
        elif j["status"] in ("running", "stalled") and j.get("pid"):
            j["status"] = "starting"
            resume.append(j["id"])
    P.save()
    srv = None
    port0 = int(__import__("os").environ.get("KTOON_PORT", "8891"))
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
    P.log(f"tap1 · The Alpha EP01 · key: {have} · trần ${P.budget():.2f}")
    P.log(f"Giao diện: {url}   (giữ cửa sổ này mở; đóng cửa sổ là tắt app, việc đang chạy sẽ tiếp tục lần sau)")
    if not NO_BROWSER:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    srv.serve_forever()


if __name__ == "__main__":
    main()
