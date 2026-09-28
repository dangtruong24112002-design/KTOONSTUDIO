"""End-to-end click-through of the episode test app against the mock providers."""
import json
import sys
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
SHOTS = HERE / "shots"
SHOTS.mkdir(exist_ok=True)
URL = "http://127.0.0.1:8790/"
errors = []


def state(page):
    return page.evaluate("S")


def wait_idle(page, what, timeout=90):
    t0 = time.time()
    time.sleep(0.8)
    while time.time() - t0 < timeout:
        s = state(page)
        if s and len(s["jobs"]) > BEFORE[0] and not any(j["status"] in ("queued", "starting", "running") for j in s["jobs"]):
            return s
        time.sleep(0.5)
    raise SystemExit(f"timeout waiting for {what}")


BEFORE = [0]


def run_button(page, text):
    BEFORE[0] = len(state(page)["jobs"])
    btn = page.locator("button.primary", has_text=text).first
    btn.click()
    page.wait_for_selector("#modal:not([hidden])")
    title = page.inner_text("#mTitle")
    page.click("#mOk")
    return title


def tab(page, name):
    page.click(f"nav button[data-tab='{name}']")
    page.wait_for_timeout(300)


with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={"width": 1360, "height": 900})
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.goto(URL)
    page.wait_for_function("() => typeof S !== 'undefined' && S && S.keys")
    tab(page, "script")
    print("step1 modal:", run_button(page, "Viết kịch bản"))
    s = wait_idle(page, "script")
    assert s["script"].startswith("TÓM TẮT"), s["script"][:50]
    page.wait_for_timeout(2500)
    page.screenshot(path=str(SHOTS / "1_script.png"), full_page=False)

    tab(page, "plan")
    print("step2 modal:", run_button(page, "Tạo shot list"))
    s = wait_idle(page, "plan")
    assert s["plan"] and len(s["plan"]["shots"]) == 18, "plan missing"
    page.wait_for_timeout(2500)
    # edit: S02 duration 6 and voice for mark
    page.locator("[data-shot='S02'] input[data-f='duration']").fill("6")
    page.locator("[data-char='mark'] select[data-f='voice']").select_option("Imposing_Manner")
    page.wait_for_selector("#dirtybar")
    page.click("button[data-act='save-plan']")
    page.wait_for_timeout(1500)
    s = state(page)
    assert s["plan"]["shots"][1]["duration"] == 6, s["plan"]["shots"][1]
    assert [c for c in s["plan"]["characters"] if c["id"] == "mark"][0]["voice"] == "Imposing_Manner"
    page.screenshot(path=str(SHOTS / "2_plan.png"))

    tab(page, "cast")
    print("step3 modal:", run_button(page, "Tạo ảnh còn thiếu"))
    s = wait_idle(page, "cast")
    page.wait_for_timeout(2500)
    page.screenshot(path=str(SHOTS / "3_cast.png"))
    assert all(("char:" + c["id"]) in s["picks"] for c in s["plan"]["characters"])

    tab(page, "kf")
    print("step4 modal:", run_button(page, "Tạo keyframe còn thiếu"))
    s = wait_idle(page, "kf")
    page.wait_for_timeout(2500)
    page.screenshot(path=str(SHOTS / "4_kf.png"))
    assert sum(1 for k in s["picks"] if k.startswith("kf:")) == 18

    tab(page, "vid")
    print("step5 probe modal:", run_button(page, "Đo giá thật"))
    s = wait_idle(page, "probe")
    page.wait_for_timeout(2500)
    measured = [(j["model"], j["measured"]) for j in s["jobs"] if j.get("measured")]
    print("measured:", json.dumps(measured))
    page.screenshot(path=str(SHOTS / "5a_probe.png"))
    print("step5 modal:", run_button(page, "Tạo video còn thiếu"))
    s = wait_idle(page, "video")
    page.wait_for_timeout(2500)
    page.screenshot(path=str(SHOTS / "5b_video.png"))
    assert sum(1 for k in s["picks"] if k.startswith("vid:")) == 18

    tab(page, "voice")
    print("step6 modal:", run_button(page, "Tạo giọng + khẩu hình"))
    s = wait_idle(page, "voice")
    page.wait_for_timeout(2500)
    fails = [j for j in s["jobs"] if j["kind"] == "lip" and j["status"] == "failed"]
    print("lip fails (expected 1):", [(j["id"], j["error"]) for j in fails])
    page.screenshot(path=str(SHOTS / "6a_voice.png"))
    # retry the failed lip-sync from its tile
    target = fails[0]["target"]
    tile_btn = page.locator(f"button[data-act='run'][data-stage='lip'][data-target='{target}']")
    BEFORE[0] = len(state(page)["jobs"])
    if tile_btn.count() and tile_btn.is_enabled():
        tile_btn.click()
    else:  # no live take yet -> top button creates the missing one
        page.locator("button.primary", has_text="Tạo giọng + khẩu hình").first.click()
    page.wait_for_selector("#modal:not([hidden])")
    print("retry modal:", page.inner_text("#mTitle"))
    page.click("#mOk")
    s = wait_idle(page, "lip retry")
    page.wait_for_timeout(2500)
    lips = [k for k in s["picks"] if k.startswith("lip:")]
    print("lip picks:", len(lips), "dialogue shots:", sum(1 for x in s["plan"]["shots"] if x["line"]))
    page.screenshot(path=str(SHOTS / "6b_voice.png"))

    tab(page, "watch")
    page.click("button[data-act='play-all']")
    page.wait_for_timeout(1500)
    print("player src:", page.eval_on_selector("#pv", "v => v.currentSrc"), "|", page.inner_text("#pvLabel"))
    page.click("button[data-act='export']")
    t0 = time.time()
    while time.time() - t0 < 120:
        s = state(page)
        if s["export"].get("status") in ("done", "failed"):
            break
        time.sleep(1)
    print("export:", s["export"])
    page.wait_for_timeout(2500)
    page.screenshot(path=str(SHOTS / "7_watch.png"))

    tab(page, "cost")
    page.wait_for_timeout(1500)
    page.screenshot(path=str(SHOTS / "8_cost.png"), full_page=True)
    print("money:", s["money"], "balance:", s["balance"])

    tab(page, "settings")
    page.wait_for_timeout(800)
    page.screenshot(path=str(SHOTS / "9_settings.png"), full_page=True)

    # mobile layout check
    m = b.new_page(viewport={"width": 390, "height": 844})
    m.goto(URL)
    m.wait_for_function("() => typeof S !== 'undefined' && S && S.keys")
    m.click("nav button[data-tab='vid']")
    m.wait_for_timeout(1200)
    sw = m.evaluate("document.documentElement.scrollWidth")
    print("mobile scrollWidth:", sw)
    m.screenshot(path=str(SHOTS / "m_vid.png"))
    b.close()

print("page errors:", errors)
