"""Mock WaveSpeed (media + LLM + balance) and Atlas Cloud (video + balance) for offline tests of app.py."""
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT = int(sys.argv[1])
HERE = Path(__file__).resolve().parent
WS_KEY, AT_KEY = "Bearer test-ws-key-123456", "Bearer test-atlas-key-123456"
BAL = {"ws": 50.0, "atlas": 30.0}
ATLAS_PRICE = {"bytedance/seedance-2.5/image-to-video": 0.30, "bytedance/seedance-2.0/image-to-video": 0.112,
               "bytedance/seedance-2.0-fast/image-to-video": 0.0581, "bytedance/seedance-2.0-mini/image-to-video": 0.0242}
LOG, POLLS, PRED, N = [], {}, {}, [0]
FAIL_FIRST_LIP = [True]
LOCK = threading.Lock()

SCRIPT = """TÓM TẮT (tiếng Việt): Ethan, tỷ phú giả làm thợ bảo trì, bị Mark sỉ nhục ở tầng 40. Claire giúp anh. Cuối tập Ethan bước vào phòng họp: anh là chủ tòa nhà.
CHARACTERS: Ethan Cole (33): navy work jacket. Claire Hayes (29): cream blouse. Mark Dalton (40): grey suit.
LOCATIONS: 40th floor corridor; glass boardroom.
SCREENPLAY:
INT. 40TH FLOOR CORRIDOR - DAY
Ethan steps out of the elevator with a toolbox.
CLAIRE: You're not supposed to be up here.
MARK: Janitors use the service lift.
INT. GLASS BOARDROOM - DAY
ETHAN: Actually... I own this building."""


def plan_json():
    tiers = ["A", "B", "C", "B", "B", "C", "B", "B", "A", "C", "B", "B", "C", "B", "B", "C", "B", "A"]
    lines = {2: ("claire", "You're not supposed to be up here."), 4: ("mark", "Janitors use the service lift, pal."),
             7: ("ethan", "I'll be quick."), 11: ("claire", "Here. Take this."), 17: ("ethan", "Actually... I own this building.")}
    shots = []
    for i, t in enumerate(tiers):
        sp, ln = lines.get(i + 1, ("", ""))
        cast = ["ethan", "claire"] if i % 3 == 0 else (["mark"] if i % 3 == 1 else [])
        if sp and sp not in cast:
            cast = [sp] + cast
        shots.append({"tier": t, "duration": 5, "location": "L1" if i < 12 else "L2", "cast": cast, "speaker": sp, "line": ln,
                      "note_vi": f"Shot {i + 1} ghi chú", "keyframe_prompt": "Keep the exact face of the man in image 1. Film still. {location}. No text, no watermark.",
                      "video_prompt": "[0-2s] slow push-in. [2-5s] reaction. {location}. Strictly keep the faces from the first frame. No subtitles, no background music, no AI artifacts."})
    return json.dumps({"title": "The Billionaire Undercover · Ep 1",
                       "characters": [{"id": "ethan", "name": "Ethan Cole", "look": "Photoreal portrait of Ethan. No text, no logo, no watermark.", "voice": "Deep_Voice_Man"},
                                      {"id": "claire", "name": "Claire Hayes", "look": "Photoreal portrait of Claire. No text, no logo, no watermark.", "voice": "Calm_Woman"},
                                      {"id": "mark", "name": "Mark Dalton", "look": "Photoreal portrait of Mark. No text, no logo, no watermark.", "voice": "NotAVoice"}],
                       "locations": [{"id": "L1", "name": "Corridor", "block": "40th floor corridor, cool daylight"},
                                     {"id": "L2", "name": "Boardroom", "block": "glass boardroom, skyline"}],
                       "shots": shots})


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def send(self, code, obj=None, raw=None, ctype="application/json"):
        body = raw if raw is not None else json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(n) or b"{}")
        auth = self.headers.get("Authorization")
        with LOCK:
            LOG.append({"path": self.path, "body": body, "auth": auth, "t": time.time()})
        if self.path == "/llm/chat/completions":
            if auth != WS_KEY:
                return self.send(401, {"error": "bad key"})
            sysmsg = body["messages"][0]["content"]
            time.sleep(0.5)
            content = SCRIPT if "head writer" in sysmsg else plan_json()
            with LOCK:
                BAL["ws"] -= 0.02
            return self.send(200, {"choices": [{"message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
                                   "usage": {"prompt_tokens": 1500, "completion_tokens": 4200}})
        with LOCK:
            N[0] += 1
            pid = f"p{N[0]}"
        if self.path.startswith("/ws/"):
            if auth != WS_KEY:
                return self.send(401, {"error": "bad key"})
            model = self.path[4:]
            fail = False
            if "infinitetalk" in model and FAIL_FIRST_LIP[0]:
                FAIL_FIRST_LIP[0] = False
                fail = True
            kind = "lip" if "infinitetalk" in model else ("tts" if "speech" in model else "img")
            cost = {"img": 0.027, "tts": 0.06 * len(body.get("text", "")) / 1000, "lip": 0.075}[kind]
            with LOCK:
                BAL["ws"] -= cost
                PRED["ws-" + pid] = {"kind": kind, "fail": fail}
            return self.send(200, {"code": 200, "message": "success", "data": {"id": "ws-" + pid, "status": "created"}})
        if self.path == "/atlas/generateVideo":
            if auth != AT_KEY:
                return self.send(401, {"error": "bad key"})
            price = ATLAS_PRICE.get(body.get("model"), 0.1)
            with LOCK:
                BAL["atlas"] -= price * int(body.get("duration", 5))
                PRED["at-" + pid] = {"kind": "vid", "fail": False}
            return self.send(200, {"code": 200, "data": {"id": "at-" + pid}})
        self.send(404, {"error": "no route " + self.path})

    def do_GET(self):
        if self.path.startswith("/files/"):
            f = HERE / "files" / self.path.split("/")[-1].split("?")[0]
            if f.exists():
                return self.send(200, raw=f.read_bytes(), ctype="application/octet-stream")
            return self.send(404, {"error": "nofile"})
        auth = self.headers.get("Authorization")
        if self.path == "/ws/balance":
            if auth != WS_KEY:
                return self.send(401, {"error": "bad key"})
            return self.send(200, {"code": 200, "message": "success", "data": {"balance": round(BAL["ws"], 4)}})
        if self.path == "/atlaspub/balance":
            if auth != AT_KEY:
                return self.send(401, {"error": "bad key"})
            return self.send(200, {"object": "balance", "available": {"value": f"{BAL['atlas']:.6f}", "currency": "usd"}})
        with LOCK:
            POLLS[self.path] = POLLS.get(self.path, 0) + 1
            done = POLLS[self.path] >= 2
        if self.path.startswith("/ws/predictions/"):
            if auth != WS_KEY:
                return self.send(401, {"error": "bad key"})
            pid = self.path.split("/")[3]
            info = PRED.get(pid, {"kind": "img", "fail": False})
            if done and info["fail"]:
                return self.send(200, {"code": 200, "data": {"id": pid, "status": "failed", "error": "face not detected (mock)"}})
            fname = {"img": "img.jpg", "tts": "tts.mp3", "lip": "lip.mp4"}[info["kind"]]
            out = f"http://127.0.0.1:{PORT}/files/{fname}"
            return self.send(200, {"code": 200, "data": {"id": pid, "status": "completed" if done else "processing", "outputs": [out] if done else []}})
        if self.path.startswith("/atlas/prediction/"):
            if auth != AT_KEY:
                return self.send(401, {"error": "bad key"})
            pid = self.path.rsplit("/", 1)[1]
            out = f"http://127.0.0.1:{PORT}/files/vid.mp4"
            return self.send(200, {"code": 200, "data": {"id": pid, "status": "completed" if done else "processing", "outputs": [out] if done else []}})
        self.send(404, {"error": "no route " + self.path})


def dump():
    while True:
        time.sleep(0.5)
        with LOCK:
            data = json.dumps({"log": LOG, "bal": BAL})
        (HERE / "mock_log.json").write_text(data)


threading.Thread(target=dump, daemon=True).start()
srv = ThreadingHTTPServer(("127.0.0.1", PORT), H)
srv.daemon_threads = True
srv.serve_forever()
