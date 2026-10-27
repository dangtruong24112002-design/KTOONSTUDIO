#!/usr/bin/env python3
"""KTOONSTUDIO · tập thử v2 (series + tập, batch Omni Reference). Xem docs/SPEC_TAP_THU_V2.md §15.

Bấm đúp chay_windows.bat (Windows) hoặc chay_mac.command (Mac): app mở giao diện trên trình duyệt.
Key đọc từ keys.txt (WAVESPEED_API_KEY, ATLASCLOUD_API_KEY, BUDGET_USD), không bao giờ gửi ra
trình duyệt hay ghi vào file khác. Chỉ dùng thư viện có sẵn của Python 3.8 trở lên.
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
import updater
from pipeline import HERE, OUT, STATE, KEYS, LOCK, RUNNING

TOKEN = __import__("os").environ.get("KTOON_TEST_TOKEN") or secrets.token_urlsafe(18)
PORT = [8766]
NO_BROWSER = __import__("os").environ.get("KTOON_NO_BROWSER") == "1"

CTYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
          ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
          ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mp3": "audio/mpeg",
          ".wav": "audio/wav", ".csv": "text/csv; charset=utf-8", ".txt": "text/plain; charset=utf-8",
          ".json": "application/json; charset=utf-8"}


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
                page = (HERE / "ui.html").read_text(encoding="utf-8").replace("__TAPTHU_TOKEN__", TOKEN)
                return self._send(200, page, "text/html; charset=utf-8")
            if path == "/api/state":
                if self.headers.get("X-Tapthu-Token") != TOKEN:
                    return self._send(403, {"error": "token"})
                state = P.public_state()
                state["update"] = updater.status()
                state["github_repo"] = updater.github_repo()
                state["github_token_preview"] = P.mask_key(KEYS.get("GITHUB_TOKEN"))
                return self._send(200, state)
            if path.startswith("/files/"):
                rel = path[len("/files/"):]
                target = (P.DATA_DIR / rel).resolve()
                if P.DATA_DIR.resolve() not in target.parents or not target.is_file():
                    return self._send(404, {"error": "không có file"})
                return self._file(target)
            return self._send(404, {"error": "không có"})
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def do_POST(self):
        if not self._host_ok() or self.headers.get("X-Tapthu-Token") != TOKEN:
            return self._send(403, {"error": "Phiên không hợp lệ — tải lại trang."})
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        try:
            if path == "/api/upload":
                return self._send(200, self.upload(parse_qs(parsed.query), raw))
            if path == "/api/upload_text":
                return self._send(200, self.upload_text(parse_qs(parsed.query), raw))
            if path == "/api/knowledge/upload_file":
                return self._send(200, self.knowledge_upload_file(parse_qs(parsed.query), raw))
            data = json.loads(raw.decode("utf-8") or "{}")
            return self._send(200, self.route(path, data))
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except Exception as e:
            P.log(traceback.format_exc())
            return self._send(200, {"error": P.scrub(str(e))})

    def upload(self, q, raw):
        def one(k, d=""):
            return (q.get(k) or [d])[0]
        kind, ext, label = one("kind"), one("ext", ".bin"), one("label")
        try:
            if kind == "component":
                comp = P.add_component(one("char"), raw, ext, label, one("source", "ai"), one("use", "other"))
                return {"ok": True, "component": comp}
            if kind == "chat_attach":
                job = P.create_chat_attachment(raw, ext, label, one("source", "ai"), one("use", "other"))
                return {"ok": True, "job": job["id"]}
            job = P.upload_asset(kind, one("target"), raw, ext, label)
            return {"ok": True, "job": job["id"]}
        except (ValueError, P.ApiError) as e:
            return {"error": str(e)}

    def upload_text(self, q, raw):
        purpose = (q.get("purpose") or [""])[0]
        filename = (q.get("filename") or ["file.txt"])[0]
        try:
            text = P.extract_text(raw, filename)
        except ValueError as e:
            return {"error": str(e)}
        with LOCK:
            if purpose == "script":
                STATE["script_raw"] = (STATE["script_raw"] + "\n\n" + text).strip() if STATE["script_raw"].strip() else text
            elif purpose == "list":
                STATE["list_raw"] = (STATE["list_raw"] + "\n\n" + text).strip() if STATE["list_raw"].strip() else text
            else:
                return {"error": "purpose không hợp lệ."}
        P.save()
        return {"ok": True, "chars": len(text)}

    def knowledge_upload_file(self, q, raw):
        def one(k, d=""):
            return (q.get(k) or [d])[0]
        filename, kid, name = one("filename", "file.txt"), one("id"), one("name")
        try:
            text = P.extract_text(raw, filename)
        except ValueError as e:
            return {"error": str(e)}
        try:
            if kid:
                v = P.add_knowledge_version(kid, text)
                return {"ok": True, "id": kid, "v": v}
            doc, v = P.upload_knowledge(name or filename, text)
            return {"ok": True, "id": doc["id"], "v": v}
        except (ValueError, P.ApiError) as e:
            return {"error": str(e)}

    def route(self, path, d):
        try:
            return self._route(path, d)
        except (ValueError, P.ApiError) as e:
            return {"error": str(e)}

    def _route(self, path, d):
        if path == "/api/video/edit":
            result = P.create_video_edit_job(d.get("source_job"), d.get("prompt"), d.get("mode", "max"))
            if result.get("ok") and result.get("job"):
                threading.Thread(target=P.run_video_edit, args=(result["job"],), daemon=True).start()
            return result
        if path == "/api/run":
            return P.create_jobs(d.get("stage"), d.get("target") or None, bool(d.get("redo")), bool(d.get("dry")))
        if path == "/api/pick":
            with LOCK:
                j = STATE["jobs"].get(d.get("job"))
                if not j or j["status"] != "done":
                    return {"error": "Bản này chưa xong."}
                STATE["picks"][f"{j['kind']}:{j['target']}"] = j["id"]
            P.save()
            return {"ok": True}
        if path == "/api/recheck":
            with LOCK:
                j = STATE["jobs"].get(d.get("job"))
                if not j or j["status"] != "stalled" or not j.get("pid"):
                    return {"error": "Việc này không cần hỏi lại."}
                j["status"] = "starting"
                RUNNING.add(j["id"])
            threading.Thread(target=P.run_job, args=(j["id"],), daemon=True).start()
            return {"ok": True}
        if path == "/api/cancel":
            with LOCK:
                n = 0
                for j in STATE["jobs"].values():
                    if j["status"] == "queued":
                        j.update(status="cancelled", error="Đã huỷ trước khi gửi — không tốn tiền.")
                        n += 1
            P.save()
            return {"ok": True, "n": n}
        if path == "/api/reload_keys":
            KEYS.clear()
            KEYS.update(P.load_keys())
            threading.Thread(target=P.refresh_balances, daemon=True).start()
            return {"ok": True, "keys": {p: bool(KEYS.get(k)) for p, k in P.KEY_OF.items()}, "budget": P.budget()}
        if path == "/api/keys/save":
            updates = {}
            if "wavespeed" in d and str(d["wavespeed"]).strip():
                updates[P.KEY_OF["wavespeed"]] = str(d["wavespeed"]).strip()
            if "atlas" in d and str(d["atlas"]).strip():
                updates[P.KEY_OF["atlas"]] = str(d["atlas"]).strip()
            if "eachlabs" in d and str(d["eachlabs"]).strip():
                updates[P.KEY_OF["eachlabs"]] = str(d["eachlabs"]).strip()
            if "data_dir" in d and str(d["data_dir"]).strip():
                updates["DATA_DIR"] = str(d["data_dir"]).strip()
            if "github_token" in d and str(d["github_token"]).strip():
                updates["GITHUB_TOKEN"] = str(d["github_token"]).strip()
            if "github_repo" in d and str(d["github_repo"]).strip():
                updates["GITHUB_REPO"] = str(d["github_repo"]).strip()
            if not updates:
                return {"error": "Chưa nhập gì để lưu."}
            P.save_home_keys(updates)
            KEYS.clear()
            KEYS.update(P.load_keys())
            threading.Thread(target=P.refresh_balances, daemon=True).start()
            return {"ok": True, "note": "DATA_DIR" in updates and "Đổi thư mục dữ liệu cần khởi động lại app để áp dụng." or ""}
        if path == "/api/update/check_now":
            threading.Thread(target=lambda: updater.check_and_apply(PORT[0], force=True), daemon=True).start()
            return {"ok": True}
        if path == "/api/balance":
            P.refresh_balances(reset_start=bool(d.get("reset_start")))
            return {"ok": True}
        if path == "/api/project":
            with LOCK:
                STATE["project"]["name"] = str(d.get("name") or STATE["project"]["name"]).strip() or STATE["project"]["name"]
            P.save()
            return {"ok": True}
        if path == "/api/script_raw":
            with LOCK:
                STATE["script_raw"] = str(d.get("text") or "")
            P.save()
            return {"ok": True}
        if path == "/api/list_raw":
            with LOCK:
                STATE["list_raw"] = str(d.get("text") or "")
            P.save()
            return {"ok": True}
        if path == "/api/style":
            with LOCK:
                STATE["style"] = str(d.get("text") or "")
            P.save()
            return {"ok": True}
        if path == "/api/template":
            key = d.get("key")
            if key not in STATE["templates"]:
                return {"error": "Không có mẫu này."}
            with LOCK:
                STATE["templates"][key] = str(d.get("text") or "")
            P.save()
            return {"ok": True}
        if path == "/api/reflib/path":
            r = P.reflib_set_path(str(d.get("path") or ""))
            return {"ok": True, **r}
        if path == "/api/knowledge/paste":
            kid = d.get("id")
            if kid:
                v = P.add_knowledge_version(kid, str(d.get("text") or ""))
                return {"ok": True, "id": kid, "v": v}
            doc, v = P.upload_knowledge(str(d.get("name") or "").strip(), str(d.get("text") or ""))
            return {"ok": True, "id": doc["id"], "v": v}
        if path == "/api/knowledge/set_version":
            P.set_knowledge_version(d.get("id"), d.get("v"))
            return {"ok": True}
        if path == "/api/knowledge/remove":
            P.remove_knowledge_doc(d.get("id"))
            return {"ok": True}
        if path == "/api/knowledge/condensed":
            P.set_condensed(d.get("id"), d.get("text"), bool(d.get("approved")))
            return {"ok": True}
        if path == "/api/knowledge/set_section":
            P.set_section_slots(d.get("id"), d.get("sec_id"), d.get("slots"), d.get("approved"))
            return {"ok": True}
        if path == "/api/episode/script":
            P.episode(d.get("ep"))["script_raw"] = str(d.get("text") or "")
            P.save()
            return {"ok": True}
        if path == "/api/episode/shotlist":
            P.apply_shotlist_md(d.get("ep"), str(d.get("text") or ""))
            return {"ok": True}
        if path == "/api/batch/ref_mode":
            P.set_batch_ref_mode(d.get("id"), str(d.get("mode") or "both"))
            return {"ok": True}
        if path == "/api/approve":
            P.set_approved(d.get("bank"), d.get("id"), bool(d.get("approved")))
            return {"ok": True}
        if path == "/api/chat":
            return P.create_chat_job(d.get("kind"), d.get("target"), str(d.get("text") or ""), d.get("model"),
                                      d.get("resolution") or "2k", d.get("attachments") or [], bool(d.get("dry")))
        if path == "/api/char/new":
            return {"ok": True, "char": P.new_char(str(d.get("name") or "").strip())}
        if path == "/api/char/desc":
            with LOCK:
                c = STATE["chars"].get(d.get("id"))
                if not c:
                    return {"error": "Không có nhân vật này."}
                c["desc"] = str(d.get("text") or "")
                if "name" in d and str(d["name"]).strip():
                    c["name"] = str(d["name"]).strip()
            P.save()
            return {"ok": True}
        if path == "/api/component/remove":
            P.remove_component(d.get("char"), d.get("comp"))
            return {"ok": True}
        if path == "/api/env/new":
            return {"ok": True, "env": P.new_env(str(d.get("name") or "").strip(), str(d.get("tag") or "EXT").upper(),
                                                  str(d.get("time") or "day"))}
        if path == "/api/env/text":
            with LOCK:
                e = STATE["envs"].get(d.get("id"))
                if not e:
                    return {"error": "Không có bối cảnh này."}
                if "text" in d:
                    e["text"] = str(d.get("text") or "")
                if d.get("tag") in ("INT", "EXT"):
                    e["tag"] = d["tag"]
                if d.get("time") in ("day", "night"):
                    e["time"] = d["time"]
            P.save()
            return {"ok": True}
        if path == "/api/prop/new":
            return {"ok": True, "prop": P.new_prop(str(d.get("name") or "").strip())}
        if path == "/api/voice/new":
            return {"ok": True, "voice": P.new_voice(str(d.get("name") or "").strip(), str(d.get("char") or ""))}
        if path == "/api/videoref/new":
            return {"ok": True, "ref": P.new_video_ref(str(d.get("name") or "").strip())}
        if path == "/api/episode/new":
            return {"ok": True, "episode": P.new_episode(str(d.get("name") or "").strip())}
        if path == "/api/episode/shots":
            with LOCK:
                eid = d.get("ep")
                ep = STATE["episodes"].get(eid)
                if not ep:
                    return {"error": "Không có tập này."}
                ep["shots"] = P.normalize_shots_for_episode(eid, d.get("shots") or [])
            P.save()
            return {"ok": True}
        if path == "/api/episode/batches/split":
            with LOCK:
                eid = d.get("ep")
                if eid not in STATE["episodes"]:
                    return {"error": "Không có tập này."}
                ep = STATE["episodes"][eid]
                ep["batches"] = P.split_batches_by_sequence(eid) if ep.get("shotlist_md", "").strip() else P.split_batches(eid)
            P.save()
            return {"ok": True}
        if path == "/api/episode/batches/save":
            with LOCK:
                eid = d.get("ep")
                if eid not in STATE["episodes"]:
                    return {"error": "Không có tập này."}
                STATE["episodes"][eid]["batches"] = P.normalize_batches(eid, d.get("batches") or [])
            P.save()
            return {"ok": True}
        if path == "/api/shot/storyboard":
            with LOCK:
                sh = P.shot_by_id(d.get("id"))
                if not sh:
                    return {"error": "Không có shot này."}
                sh["storyboard_on"] = bool(d.get("on"))
            P.save()
            return {"ok": True}
        if path == "/api/prompt":
            bid = d.get("batch")
            ep, b = P.batch_by_id(bid)
            if not b:
                return {"error": "Không có batch này."}
            with LOCK:
                p = ep["prompts"].setdefault(bid, {})
                if "text" in d:
                    p["text"] = str(d.get("text") or "")
                    p["approved"] = False
                if "approved" in d:
                    p["approved"] = bool(d.get("approved"))
            P.save()
            return {"ok": True}
        if path == "/api/qc":
            bid = d.get("batch")
            ep, b = P.batch_by_id(bid)
            if not b:
                return {"error": "Không có batch này."}
            with LOCK:
                q = ep["qc"].setdefault(bid, {})
                for k in ("sharp", "raccord", "voice"):
                    if k in d:
                        q[k] = bool(d[k])
                if "note" in d:
                    q["note"] = str(d.get("note") or "")
                if "result" in d and d["result"] in ("pass", "fail", None):
                    q["result"] = d["result"]
            P.save()
            return {"ok": True}
        if path == "/api/fix/new":
            f = P.new_fix(d.get("batch"), d.get("start", 0), d.get("end", 10))
            return {"ok": True, "fix": f}
        if path == "/api/fix/prompt":
            f = P._find_fix_safe(d.get("id"))
            if not f:
                return {"error": "Không có fix này."}
            with LOCK:
                f["prompt"] = str(d.get("text") or "")
            P.save()
            return {"ok": True}
        if path == "/api/export":
            eid = d.get("ep")
            if eid not in STATE["episodes"]:
                return {"error": "Không có tập này."}
            with LOCK:
                if STATE["episodes"][eid]["export"].get("status") == "running":
                    return {"error": "Đang xuất."}
                STATE["episodes"][eid]["export"] = {"status": "running", "t": P.ts()}
            threading.Thread(target=P.do_export, args=(eid,), daemon=True).start()
            return {"ok": True}
        if path == "/api/settings":
            new = d.get("settings") or {}
            with LOCK:
                for k, v in new.items():
                    if k not in P.DEFAULT_SETTINGS:
                        continue
                    if isinstance(P.DEFAULT_SETTINGS[k], (int, float)) and not isinstance(P.DEFAULT_SETTINGS[k], bool):
                        try:
                            v = float(v)
                        except (TypeError, ValueError):
                            return {"error": f"{k} phải là số."}
                        if isinstance(P.DEFAULT_SETTINGS[k], int):
                            v = int(v)
                    STATE["settings"][k] = v.strip() if isinstance(v, str) else v
            P.save()
            return {"ok": True}
        return {"error": "Không rõ yêu cầu."}


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "media").mkdir(exist_ok=True)
    P.PROJECTS.mkdir(parents=True, exist_ok=True)
    P.EXPORT_DIR.mkdir(parents=True, exist_ok=True)
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
    port0 = int(__import__("os").environ.get("KTOON_PORT", "8766"))
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
    updater.start_poller(PORT[0])
    url = f"http://127.0.0.1:{PORT[0]}/"
    have = ", ".join(P.PROVIDER_NAME[p] for p, k in P.KEY_OF.items() if KEYS.get(k)) or "chưa có key nào"
    P.log(f"Tập thử v2 · key: {have} · trần ${P.budget():.2f}")
    P.log(f"Giao diện: {url}   (giữ cửa sổ này mở; đóng cửa sổ là tắt app, việc đang chạy sẽ tiếp tục lần sau)")
    if not NO_BROWSER:
        try:
            webbrowser.open(url)
        except Exception:
            pass
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        P.log("Đã tắt app.")


if __name__ == "__main__":
    main()
