"""End-to-end click-through of tap_thu_v2 against the mock providers, covering the addendum #3
(mục 15) flow: series-level script/list upload -> split into episodes -> character/env/prop bank ->
reference library -> per-episode batches -> prompt/review -> gen (with last-frame chaining) -> fix ->
export. Never calls real APIs. Run: bash run_env_v2.sh && python3 checks_v2.py && python3 e2e_v2.py
(screenshots go to shots_v2/)
"""
import io
import json
import re
import time
import zipfile
from pathlib import Path
from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
SHOTS = HERE / "shots_v2"
SHOTS.mkdir(exist_ok=True)
FILES = HERE / "files"
RUN = HERE / "run_v2"
_out = RUN / "app.out"
_m = re.search(r"127\.0\.0\.1:(\d+)", _out.read_text()) if _out.exists() else None
PORT = _m.group(1) if _m else "8890"
URL = f"http://127.0.0.1:{PORT}/"
errors = []


def make_docx(paragraphs):
    """Build a minimal, valid .docx in-memory with stdlib only (zipfile + literal XML) —
    exercises pipeline._extract_docx(), which reads word/document.xml the same way."""
    content_types = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                      '<Default Extension="xml" ContentType="application/xml"/>'
                      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
                      '</Types>')
    rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
            '</Relationships>')
    body = "".join(f"<w:p><w:r><w:t>{p}</w:t></w:r></w:p>" for p in paragraphs)
    doc = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
           '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
           f'<w:body>{body}</w:body></w:document>')
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types)
        z.writestr("_rels/.rels", rels)
        z.writestr("word/document.xml", doc)
    return buf.getvalue()


def state(page):
    return page.evaluate("S")


def wait_idle(page, before_n, what, timeout=60):
    t0 = time.time()
    while time.time() - t0 < timeout:
        s = state(page)
        if s and len(s["jobs"]) > before_n and not any(j["status"] in ("queued", "starting", "running") for j in s["jobs"]):
            return s
        time.sleep(0.4)
    raise SystemExit(f"timeout waiting for {what}")


def jump(page, sec_id):
    page.evaluate(f"document.getElementById('{sec_id}') && document.getElementById('{sec_id}').scrollIntoView()")
    page.wait_for_timeout(150)


def run_and_confirm(page, sel):
    before = len(state(page)["jobs"])
    page.click(sel)
    page.wait_for_selector("#modal:not([hidden])")
    title = page.inner_text("#mTitle")
    page.click("#mOk")
    return title, before


with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/opt/pw-browsers/chromium")
    page = b.new_page(viewport={"width": 1400, "height": 950})
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "favicon" not in m.text else None)
    page.goto(URL)
    page.wait_for_function("() => typeof S !== 'undefined' && S && S.keys")

    # 1. Dự án
    page.fill("#pname", "BillionaireSeries")
    page.click("button[data-act='save-project']")
    page.wait_for_timeout(200)

    # 2. Kịch bản + shot list: upload a real two-episode .docx (exercises stdlib docx parsing),
    # then split into episodes.
    docx_bytes = make_docx([
        "EP01", "INT. CORRIDOR - DAY. Ethan sneaks past security, toolbox in hand.",
        'Shot 1: wide shot, 5s. Claire: "You\'re not supposed to be up here."',
        "EP02", "INT. BOARDROOM - DAY. Mark humiliates Ethan in front of the board.",
        'Shot 1: close-up, 5s. Ethan: "Actually... I own this building."',
    ])
    page.set_input_files("#scriptFile", {"name": "script.docx", "mimeType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "buffer": docx_bytes})
    page.click("button[data-act='upload-script']")
    page.wait_for_timeout(500)
    assert "EP01" in page.input_value("#scriptRaw") and "EP02" in page.input_value("#scriptRaw"), "docx upload did not populate scriptRaw"
    print("docx upload into scriptRaw OK")

    title, before = run_and_confirm(page, "button[data-act='run'][data-stage='split_episodes']")
    print("split_episodes modal:", title)
    s = wait_idle(page, before, "split_episodes")
    assert s["episodes_order"] == ["EP01", "EP02"], s["episodes_order"]
    page.screenshot(path=str(SHOTS / "1_script.png"), full_page=True)

    # 3. Danh sách nhân vật/bối cảnh/prop/style: paste text, then parse
    jump(page, "sec-list")
    page.fill("#listRaw", "Characters: Ethan, Claire, Mark. Environments: Corridor, Boardroom. Props: Toolbox. "
                          "Style: ultra realistic 8K Hollywood film, photoreal skin texture")
    page.click("button[data-act='save-list-raw']")
    page.wait_for_timeout(200)
    title, before = run_and_confirm(page, "button[data-act='run'][data-stage='parse_list']")
    print("parse_list modal:", title)
    s = wait_idle(page, before, "parse_list")
    assert len(s["chars"]) == 3 and len(s["envs"]) == 2 and len(s["props"]) == 1, s["chars"]
    assert s["style"].strip(), "style block not populated"
    page.screenshot(path=str(SHOTS / "2_list.png"), full_page=True)

    for bank in ("chars", "envs", "props"):
        for iid in list(s[bank].keys()):
            page.click(f"button[data-act='approve'][data-bank='{bank}'][data-id='{iid}']")
            page.wait_for_timeout(150)
    s = state(page)
    assert all(c["approved"] for c in s["chars"].values()), "approve did not stick"
    char_ids = list(s["chars"].keys())
    env_ids = list(s["envs"].keys())

    # 4. Kho ref: point at a fixture folder with AI\ and THAT\ subfolders, scan it
    jump(page, "sec-reflib")
    reflib_dir = RUN / "reflib_fixture_e2e"
    (reflib_dir / "AI").mkdir(parents=True, exist_ok=True)
    (reflib_dir / "THAT").mkdir(parents=True, exist_ok=True)
    img_bytes = (FILES / "img.jpg").read_bytes()
    (reflib_dir / "AI" / "face1.jpg").write_bytes(img_bytes)
    (reflib_dir / "AI" / "hair1.jpg").write_bytes(img_bytes)
    (reflib_dir / "THAT" / "costume1.jpg").write_bytes(img_bytes)
    page.fill("#reflibPath", str(reflib_dir))
    page.click("button[data-act='save-reflib']")
    page.wait_for_timeout(300)
    title, before = run_and_confirm(page, "button[data-act='run'][data-stage='reflib_scan']")
    print("reflib_scan modal:", title)
    s = wait_idle(page, before, "reflib_scan")
    assert s["reflib"]["n_scanned"] == 3 and s["reflib"]["n_unscanned"] == 0, s["reflib"]

    # 5. Nhân vật: suggest components from the reflib, verify hard rule (real -> never face/eyes),
    # also test that a manual real+face upload is refused by the UI/backend.
    jump(page, "sec-chars")
    for cid in char_ids:
        title, before = run_and_confirm(page, f"button[data-act='run'][data-stage='suggest_components'][data-target='{cid}']")
        print("suggest_components modal:", title)
        s = wait_idle(page, before, "suggest_components")
    comps = s["chars"][char_ids[0]]["components"]
    assert comps, "suggest_components produced nothing"
    assert not any(c["source"] == "real" and c["use"] in ("face", "eyes") for c in comps), "hard rule violated by suggestion"
    print("suggest_components respected the real+face/eyes hard rule:", [(c["source"], c["use"]) for c in comps])
    assert all(s["chars"][cid]["components"] for cid in char_ids), "not every character got suggested components"

    row0 = page.locator(f".uprow[data-kind='component'][data-id='{char_ids[0]}']").first
    row0.locator(".up-file").set_input_files(str(FILES / "img.jpg"))
    row0.locator(".up-source").select_option("real")
    row0.locator(".up-use").select_option("face")
    row0.locator("button[data-act='do-upload']").click()
    page.wait_for_timeout(400)
    s = state(page)
    assert not any(c["source"] == "real" and c["use"] == "face" for c in s["chars"][char_ids[0]]["components"]), \
        "real+face component was accepted — hard rule violated"
    print("manual real+face component upload correctly refused")

    # 6. One-click bulk generation: portraits, sheets, environments, props
    title, before = run_and_confirm(page, "button[data-act='run'][data-stage='portrait']")
    print("bulk portrait modal:", title)
    s = wait_idle(page, before, "bulk portrait", timeout=40)
    portrait_jobs = [j for j in s["jobs"] if j["kind"] == "portrait" and j["status"] == "done"]
    assert len(portrait_jobs) == len(char_ids), portrait_jobs

    title, before = run_and_confirm(page, "button[data-act='run'][data-stage='sheet']")
    print("bulk sheet modal:", title)
    s = wait_idle(page, before, "bulk sheet", timeout=40)
    assert s["picks"].get("sheet:" + char_ids[0]), "sheet missing"

    jump(page, "sec-envs")
    title, before = run_and_confirm(page, "button[data-act='run'][data-stage='env_wide']")
    print("bulk env_wide modal:", title)
    s = wait_idle(page, before, "bulk env_wide", timeout=40)
    assert s["picks"].get("env_wide:" + env_ids[0]), "env_wide missing"

    jump(page, "sec-props")
    title, before = run_and_confirm(page, "button[data-act='run'][data-stage='prop']")
    print("bulk prop modal:", title)
    s = wait_idle(page, before, "bulk prop", timeout=40)
    page.screenshot(path=str(SHOTS / "3_bank.png"), full_page=True)

    # chat-edit (addendum #2): edit the approved portrait, expect a new version + chat history
    n_before = len(state(page)["jobs"])
    box = page.locator(f".tile:has(input[data-act='char-name'][data-id='{char_ids[0]}']) details.chatbox").first
    box.locator("summary").click()
    box.locator(".chat-text").fill("doi ao khoac sang mau xanh navy")
    page.click(f"button[data-act='chat-send'][data-kind='portrait'][data-id='{char_ids[0]}']")
    page.wait_for_selector("#modal:not([hidden])")
    page.click("#mOk")
    s = wait_idle(page, n_before, "chat-edit")
    edit_job = next(j for j in s["jobs"] if j["kind"] == "portrait" and j.get("edit"))
    assert edit_job["status"] == "done", edit_job
    chat_hist = s["chats"].get("portrait:" + char_ids[0]) or []
    assert any(c["role"] == "user" for c in chat_hist) and any(c["role"] == "assistant" for c in chat_hist), chat_hist
    print("chat-edit OK, new version created")

    if s.get("llm_vision_ok", True):
        spent_before = s["cost"]["spent"]
        n_before2 = len(state(page)["jobs"])
        page.click(f"button[data-act='chat-critique'][data-kind='portrait'][data-id='{char_ids[0]}']")
        page.wait_for_selector("#modal:not([hidden])")
        page.click("#mOk")
        s = wait_idle(page, n_before2, "critique")
        chat_hist = s["chats"].get("portrait:" + char_ids[0]) or []
        assert any(c["role"] == "critique" for c in chat_hist), "critique missing from chat history"
        assert s["cost"]["spent"] > spent_before, "critique should still cost the small LLM view fee"
        print("critique OK")

    # voice + video ref
    jump(page, "sec-voices")
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

    # 7. Tập EP01: chia batch, viết prompt + duyệt, gen video (chờ khung hình cuối), QC
    jump(page, "ep-EP01")
    page.click("button[data-act='split-batches'][data-ep='EP01']")
    page.wait_for_timeout(500)
    s = state(page)
    batches = s["episodes"]["EP01"]["batches"]
    assert len(batches) >= 1, "EP01 batches missing"
    b1 = batches[0]["id"]
    b2 = batches[-1]["id"] if len(batches) > 1 else None
    page.screenshot(path=str(SHOTS / "4_batches.png"), full_page=True)

    title, before = run_and_confirm(page, "button[data-act='run'][data-stage='prompt']")
    print("bulk prompt modal:", title)
    s = wait_idle(page, before, "bulk prompt")
    assert s["episodes"]["EP01"]["prompts"][b1]["text"], "prompt missing"

    title, before = run_and_confirm(page, "button[data-act='run'][data-stage='review']")
    print("bulk review modal:", title)
    s = wait_idle(page, before, "bulk review")

    for bid in [b1] + ([b2] if b2 else []):
        page.check(f"input[data-act='approve-prompt'][data-id='{bid}']")
        page.wait_for_timeout(200)
    s = state(page)
    assert all(s["episodes"]["EP01"]["prompts"][bid]["approved"] for bid in [b1] + ([b2] if b2 else []))
    page.screenshot(path=str(SHOTS / "5_prompt.png"), full_page=True)

    title, before = run_and_confirm(page, "button[data-act='run'][data-stage='gen']")
    print("episode-wide gen modal (should only offer the first ready batch):", title)
    s = wait_idle(page, before, "gen batch 1")
    assert s["picks"].get("gen:" + b1), f"{b1} did not run"
    if b2:
        # second batch should now be unblocked (first batch has a last_frame)
        title, before = run_and_confirm(page, "button[data-act='run'][data-stage='gen']")
        print("episode-wide gen modal (chained batch):", title)
        s = wait_idle(page, before, "gen batch 2")
        assert s["picks"].get("gen:" + b2), f"{b2} did not run after {b1}"

    page.check(f"input[data-act='qc'][data-id='{b1}'][data-f='sharp']")
    page.wait_for_timeout(200)
    page.click(f"button[data-act='qc-result'][data-id='{b1}'][data-v='fail']")
    page.wait_for_timeout(300)
    s = state(page)
    assert s["episodes"]["EP01"]["qc"][b1]["result"] == "fail"
    page.screenshot(path=str(SHOTS / "6_gen.png"), full_page=True)

    # 8. Sửa đoạn hỏng: cut a frame from batch 1, fix it, patch it (only if ffmpeg is present)
    if s["ffmpeg"]:
        page.select_option("#fixBatch-EP01", b1)
        page.fill("#fixStart-EP01", "2")
        page.fill("#fixEnd-EP01", "8")
        page.click("button[data-act='new-fix'][data-ep='EP01']")
        page.wait_for_timeout(800)
        s = state(page)
        fix_id = list(s["episodes"]["EP01"]["fixes"].keys())[0]
        page.fill(f"textarea[data-act='fix-prompt'][data-id='{fix_id}']", "fix his collar and expression")
        page.click(f"button[data-act='save-fix-prompt'][data-id='{fix_id}']")
        page.wait_for_timeout(300)
        title, before = run_and_confirm(page, f"button[data-act='run'][data-stage='fix_img'][data-target='{fix_id}']")
        s = wait_idle(page, before, "fix_img")
        title, before = run_and_confirm(page, f"button[data-act='run'][data-stage='patch'][data-target='{fix_id}']")
        s = wait_idle(page, before, "patch")
        assert s["picks"].get("patch:" + fix_id), "patch missing"
    else:
        print("ffmpeg not available in this environment — skipping fix/patch (documented limitation)")
    page.screenshot(path=str(SHOTS / "7_fix.png"), full_page=True)

    # 9. Xuất tập EP01
    jump(page, "ep-EP01")
    page.click("button[data-act='export'][data-ep='EP01']")
    t0 = time.time()
    while time.time() - t0 < 30:
        s = state(page)
        if s["episodes"]["EP01"]["export"].get("status") in ("done", "failed"):
            break
        time.sleep(0.5)
    print("export:", s["episodes"]["EP01"]["export"])
    assert s["episodes"]["EP01"]["export"]["status"] == "done"
    page.screenshot(path=str(SHOTS / "8_export.png"), full_page=True)

    # 10. Chi phí
    jump(page, "sec-cost")
    page.wait_for_timeout(500)
    s = state(page)
    print("cost:", s["cost"])
    assert s["cost"]["spent"] > 0
    assert s["cost"]["series_spent"] > 0 and s["cost"]["episode_spent"] > 0, "series/episode split missing"
    page.screenshot(path=str(SHOTS / "9_cost.png"), full_page=True)

    b.close()

print("page errors:", errors)
assert not errors, errors
print("OK — all steps passed")
