"""`python -m studio` — start the local dashboard and open it in the browser."""
from __future__ import annotations

import threading
import webbrowser

import uvicorn

HOST, PORT = "127.0.0.1", 8765


def main() -> None:
    url = f"http://{HOST}:{PORT}"
    print(f"Studio OS đang chạy tại {url}  —  đóng cửa sổ này để tắt.")
    threading.Timer(1.5, lambda: webbrowser.open(url)).start()
    uvicorn.run("studio.web.app:app", host=HOST, port=PORT, log_level="warning")


if __name__ == "__main__":
    main()
