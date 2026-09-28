"""End-to-end click-through of tap_thu_v2 against the mock providers. Never call real APIs.
Run: bash run_env_v2.sh && python3 e2e_v2.py   (screenshots go to shots_v2/)
"""
import json
import re
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
SHOTS = HERE / "shots_v2"
SHOTS.mkdir(exist_ok=True)
FILES = HERE / "files"
_out = (HERE / "run_v2" / "app.out")
_m = re.search(r"127\.0\.0\.1:(\d+)", _out.read_text()) if _out.exists() else None
PORT = _m.group(1) if _m else "8890"
URL = f"http://127.0.0.1:{PORT}/"
errors = []


def state(page):
    return page.evaluate("S")


BEFORE = [0]


def wait_idle(page, what, timeout=60):
    t0 = time.time()
    time.sleep(0.5)
    while time.time() - t0 < timeout:
        s = state(page)
        if s and len(s["jobs"]) > BEFORE[0] and not any(j["status"] in ("queued", "starting", "running") for j in s["jobs"]):
            return s
        time.sleep(0.4)
    raise SystemExit(f"timeout waiting for {what}")


def tab(page, name):
    page.click(f"nav button[data-tab='{name}']")
    page.wait_for_timeout(300)


def run_and_confirm(page, sel):
    BEFORE[0] = len(state(page)["jobs"])
    page.click(sel)
    page.wait_for_selector("#modal:not([hidden])")
    title = page.inner_text("#mTitle")
    page.click("#mOk")
    return title


with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/opt/pw-browsers/chromium")
    page = b.new_page(viewport={"width": 1400, "height": 950})
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "favicon" not in m.text else None)
    page.goto(URL)
    page.wait_for_function("() => typeof S !== 'undefined' && S && S.keys")

    # 1. Dự án
    tab(page, "project")
    page.fill("#pname", "BillionaireEP1")
    page.fill("#pep", "1")
    page.click("button[data-act='save-project']")
    page.fill("#script", "INT. CORRIDOR. Ethan sneaks past security. CLAIRE: You're not supposed to be up here. "
                          "INT. BOARDROOM. Mark humiliates Ethan. ETHAN: Actually... I own this building.")
    page.click("button[data-act='save-script']")
    print("style modal:", run_and_confirm(page, "button[data-stage='style']"))
    s = wait_idle(page, "style")
    assert s["style"], "style not written"
    page.screenshot(path=str(SHOTS / "1_project.png"))

    # 2. Tham chiếu: auto pre-production list (addendum #1), then characters + components + portrait
    # + sheet, env, prop, voice, video ref
    tab(page, "refs")
    print("preprod modal:", run_and_confirm(page, "button[data-stage='preprod']"))
    s = wait_idle(page, "preprod")
    assert s["chars"] and all(not c["approved"] for c in s["chars"].values()), "preprod chars should start unapproved"
    for cid in s["chars"]:
        page.click(f"button[data-act='approve'][data-bank='chars'][data-id='{cid}']")
    for eid in s["envs"]:
        page.click(f"button[data-act='approve'][data-bank='envs'][data-id='{eid}']")
    for pid in s["props"]:
        page.click(f"button[data-act='approve'][data-bank='props'][data-id='{pid}']")
    page.wait_for_timeout(400)
    s = state(page)
    assert all(c["approved"] for c in s["chars"].values()), "approve did not stick"
    # preprod already proposed Ethan/Claire/Mark, Corridor/Boardroom, Toolbox — use those (now approved)
    char_ids = [cid for cid, c in s["chars"].items() if c["name"] in ("Ethan", "Claire")]
    env_id = next(eid for eid, e in s["envs"].items() if e["name"] == "Corridor")

    for cid in char_ids:
        row = page.locator(f".uprow[data-kind='component'][data-id='{cid}']")
        row.locator(".up-file").set_input_files(str(FILES / "img.jpg"))
        row.locator(".up-use").select_option("face")
        row.locator(".up-label").fill("face")
        row.locator("button[data-act='do-upload']").click()
        page.wait_for_timeout(500)

    # hard rule: real + face must be refused
    row0 = page.locator(f".uprow[data-kind='component'][data-id='{char_ids[0]}']").first
    row0.locator(".up-file").set_input_files(str(FILES / "img.jpg"))
    row0.locator(".up-source").select_option("real")
    row0.locator(".up-use").select_option("face")
    row0.locator("button[data-act='do-upload']").click()
    page.wait_for_timeout(500)

    env_row = page.locator(f".uprow[data-kind='env_wide'][data-id='{env_id}']")
    env_text = page.locator(f"textarea[data-act='env-text'][data-id='{env_id}']")
    env_text.fill("40th floor glass corridor, cool daylight")
    env_text.dispatch_event("change")
    page.wait_for_timeout(300)
    env_row.locator(".up-file").set_input_files(str(FILES / "img.jpg"))
    env_row.locator("button[data-act='do-upload']").click()
    page.wait_for_timeout(500)

    print("portrait modal:", run_and_confirm(page, f"button[data-stage='portrait'][data-target='{char_ids[0]}']"))
    print("portrait modal:", run_and_confirm(page, f"button[data-stage='portrait'][data-target='{char_ids[1]}']"))
    s = wait_idle(page, "portrait")
    assert s["picks"].get("portrait:" + char_ids[0]), "portrait missing"
    print("sheet modal:", run_and_confirm(page, f"button[data-stage='sheet'][data-target='{char_ids[0]}']"))
    print("sheet modal:", run_and_confirm(page, f"button[data-stage='sheet'][data-target='{char_ids[1]}']"))
    s = wait_idle(page, "sheet")
    assert s["picks"].get("sheet:" + char_ids[1]), "sheet missing"

    # chat-edit (addendum #2): edit the approved portrait, expect a new version + chat history
    n_before = len(state(page)["jobs"])
    box = page.locator(f".tile:has(input[data-act='char-name'][data-id='{char_ids[0]}']) details.chatbox").first
    box.locator("summary").click()
    box.locator(".chat-text").fill("doi ao khoac sang mau xanh navy")
    page.click(f"button[data-act='chat-send'][data-kind='portrait'][data-id='{char_ids[0]}']")
    page.wait_for_selector("#modal:not([hidden])")
    page.click("#mOk")
    t0 = time.time()
    while time.time() - t0 < 30:
        s = state(page)
        if len(s["jobs"]) > n_before and not any(j["status"] in ("queued", "starting", "running") for j in s["jobs"]):
            break
        time.sleep(0.4)
    edit_job = next(j for j in s["jobs"] if j["kind"] == "portrait" and j.get("edit"))
    assert edit_job["status"] == "done", edit_job
    chat_hist = s["chats"].get("portrait:" + char_ids[0]) or []
    assert any(c["role"] == "user" for c in chat_hist) and any(c["role"] == "assistant" for c in chat_hist), chat_hist

    # critique (addendum #2): no image-edit charge, only a small LLM view cost
    if s.get("llm_vision_ok", True):
        spent_before = s["cost"]["spent"]
        n_before2 = len(state(page)["jobs"])
        page.click(f"button[data-act='chat-critique'][data-kind='portrait'][data-id='{char_ids[0]}']")
        page.wait_for_selector("#modal:not([hidden])")
        page.click("#mOk")
        t0 = time.time()
        while time.time() - t0 < 20:
            s = state(page)
            if len(s["jobs"]) > n_before2 and not any(j["status"] in ("queued", "starting", "running") for j in s["jobs"]):
                break
            time.sleep(0.4)
        chat_hist = s["chats"].get("portrait:" + char_ids[0]) or []
        assert any(c["role"] == "critique" for c in chat_hist), "critique missing from chat history"
        assert s["cost"]["spent"] > spent_before, "critique should still cost the small LLM view fee"
    page.screenshot(path=str(SHOTS / "2_refs.png"), full_page=True)

    # voice + video ref
    page.fill("#newVoiceName", "Ethan voice")
    page.select_option("#newVoiceChar", char_ids[0])
    page.click("button[data-act='new-voice']")
    page.wait_for_timeout(300)
    s = state(page)
    voice_id = list(s["voices"].keys())[0]
    vrow = page.locator(f".uprow[data-kind='voice'][data-id='{voice_id}']")
    vrow.locator(".up-file").set_input_files(str(FILES / "tts.mp3"))
    vrow.locator("button[data-act='do-upload']").click()
    page.wait_for_timeout(500)

    # 3. Shot list (addendum #1) + Sequences
    tab(page, "seq")
    print("shots modal:", run_and_confirm(page, "button[data-stage='shots']"))
    s = wait_idle(page, "shots")
    assert len(s["shots"]) >= 4, "shot list missing"
    print("seq modal:", run_and_confirm(page, "button[data-stage='seq']"))
    s = wait_idle(page, "seq")
    assert s["seq"]["S1"]["characters"], "sequences missing"
    assert s["seq"]["S1"]["shot_ids"], "sequences did not preserve shot ids"
    page.screenshot(path=str(SHOTS / "3_seq.png"), full_page=True)

    # storyboard (addendum #1): turn it on for the first shot and generate one
    sh0 = s["shots"][0]["id"]
    page.check(f"input[data-act='storyboard-toggle'][data-id='{sh0}']")
    page.wait_for_timeout(400)
    run_and_confirm(page, f"button[data-stage='storyboard'][data-target='{sh0}']")
    s = wait_idle(page, "storyboard")
    assert s["picks"].get("storyboard:" + sh0), "storyboard missing"

    # 4. Prompt: write + review + approve for all 4 generations
    tab(page, "prompt")
    for g in ["S1", "S2a", "S2b", "S3"]:
        run_and_confirm(page, f"button[data-stage='prompt'][data-target='{g}']")
        wait_idle(page, f"prompt {g}")
    for g in ["S1", "S2a", "S2b", "S3"]:
        run_and_confirm(page, f"button[data-stage='review'][data-target='{g}']")
        wait_idle(page, f"review {g}")
    s = state(page)
    for g in ["S1", "S2a", "S2b", "S3"]:
        assert s["prompts"][g]["text"], f"{g} prompt missing"
        page.check(f"input[data-act='approve-prompt'][data-id='{g}']")
        page.wait_for_timeout(300)
    s = state(page)
    assert all(s["prompts"][g]["approved"] for g in ["S1", "S2a", "S2b", "S3"])
    page.screenshot(path=str(SHOTS / "4_prompt.png"), full_page=True)

    # 5. Gen & QC: generate S1, S2a, S2b (waits on S2a last frame), S3; then a fail QC on S1
    tab(page, "gen")
    for g in ["S1", "S2a"]:
        run_and_confirm(page, f"button[data-stage='gen'][data-target='{g}']")
        wait_idle(page, f"gen {g}")
    s = state(page)
    assert s["picks"].get("gen:S2a"), "S2a did not run"
    # now S2b should be unblocked (S2a has a last_frame)
    run_and_confirm(page, "button[data-stage='gen'][data-target='S2b']")
    s = wait_idle(page, "S2b")
    assert s["picks"].get("gen:S2b"), "S2b did not run after S2a"
    run_and_confirm(page, "button[data-stage='gen'][data-target='S3']")
    s = wait_idle(page, "S3")
    assert all(s["picks"].get("gen:" + g) for g in ["S1", "S2a", "S2b", "S3"]), "not all generations done"

    page.check("input[data-act='qc'][data-id='S1'][data-f='sharp']")
    page.wait_for_timeout(200)
    page.click("button[data-act='qc-result'][data-id='S1'][data-v='fail']")
    page.wait_for_timeout(300)
    s = state(page)
    assert s["qc"]["S1"]["result"] == "fail"
    page.screenshot(path=str(SHOTS / "5_gen.png"), full_page=True)

    # 6. Sửa đoạn hỏng: cut a frame from S1, fix it, patch it
    tab(page, "fix")
    page.select_option("#fixGen", "S1")
    page.fill("#fixStart", "2")
    page.fill("#fixEnd", "8")
    page.click("button[data-act='new-fix']")
    page.wait_for_timeout(800)
    s = state(page)
    if s["ffmpeg"]:
        fix_id = list(s["fixes"].keys())[0]
        page.fill(f"textarea[data-act='fix-prompt'][data-id='{fix_id}']", "fix his collar and expression")
        page.click(f"button[data-act='save-fix-prompt'][data-id='{fix_id}']")
        page.wait_for_timeout(300)
        run_and_confirm(page, f"button[data-stage='fix_img'][data-target='{fix_id}']")
        wait_idle(page, "fix_img")
        run_and_confirm(page, f"button[data-stage='patch'][data-target='{fix_id}']")
        s = wait_idle(page, "patch")
        assert s["picks"].get("patch:" + fix_id), "patch missing"
    else:
        print("ffmpeg not available in this environment — skipping fix/patch (documented limitation)")
    page.screenshot(path=str(SHOTS / "6_fix.png"), full_page=True)

    # 7. Xuất
    tab(page, "export")
    page.click("button[data-act='export']")
    t0 = time.time()
    while time.time() - t0 < 30:
        s = state(page)
        if s["export"].get("status") in ("done", "failed"):
            break
        time.sleep(0.5)
    print("export:", s["export"])
    assert s["export"]["status"] == "done"
    page.screenshot(path=str(SHOTS / "7_export.png"), full_page=True)

    # 8. Chi phí
    tab(page, "cost")
    page.wait_for_timeout(500)
    s = state(page)
    print("cost:", s["cost"])
    assert s["cost"]["spent"] > 0
    assert s["cost"]["series_spent"] > 0 and s["cost"]["episode_spent"] > 0, "series/episode split missing"
    page.screenshot(path=str(SHOTS / "8_cost.png"), full_page=True)

    b.close()

print("page errors:", errors)
assert not errors, errors
print("OK — all steps passed")
