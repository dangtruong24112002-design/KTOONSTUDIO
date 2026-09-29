# Changelog

- 2026-09-27 M0 (partial): WaveSpeed T1 done — 2 Seedream Flash 9:16 portraits, $0.0486 real; T2-T4 paused (balance).
- 2026-09-27 M1 (part 1): SQLite schema (BRIEF §4), asset registry, free offline script parser -> episodes + shot list JSON, Gate 1, local dashboard (`python -m studio`, port 8765) with script upload, analyse, shot list, spend box, registry and ledger screens. LLM analysis not wired yet.
- 2026-09-29 `tap_thu_v2/` (docs/SPEC_TAP_THU_V2.md, one-episode test): owner shot list paste + GPT
  sequence grouping, auto pre-production list with approve, Reference Bank (characters/environments
  /props/voices/video refs) with per-image chat editing and critique, storyboard per shot, Seedance
  2.5/2.0 Omni Reference generation for S1/S2a/S2b/S3 with price-probe and budget guard, Sửa đoạn hỏng
  patch workflow, export, and a Chi phí tab split into once-per-series vs per-episode spend. Tested
  end-to-end against `ktoon_tap_thu/tests_mock` (extended mock providers + Playwright e2e + extra
  hard-rule checks), never against real keys.
- 2026-09-29 `tap_thu_v2/` addendum #3 (docs/SPEC_TAP_THU_V2.md §15, supersedes the fixed S1/S2a/S2b/S3
  flow above): series-level script/shot-list and character/environment/prop/style-list input (upload
  .txt/.md/.docx/.xlsx/.csv via stdlib zipfile+ElementTree, or paste) auto-split into episodes that keep
  the owner's own shot count/dialogue/duration; owner-saved prompt templates per asset type that GPT
  fills instead of hardcoded prompts; a local reference-image library (AI\\/THAT\\ convention) scanned
  once with vision auto-tagging and GPT-suggested per-character components, enforcing real-photo ->
  never face/eyes everywhere; deterministic (no-LLM) per-episode batch splitting with hook/cliffhanger/
  normal tiers and Seedance 2.5/2.0 defaults; one-click bulk generation buttons for portraits/sheets/
  environments/props; per-episode batch prompt writing with generalized last-frame chaining between any
  consecutive batches; and a rewritten single continuous-page UI (series inputs on top, one card per
  episode below) that protects in-progress edits anywhere on the page from being clobbered by unrelated
  background job updates. Rewrote `e2e_v2.py`/`checks_v2.py` for the new flow (still mocks only) and
  fixed two rendering staleness bugs and one focus-tracking bug found while building the new UI.
- 2026-09-29 Thêm mục "Cài đặt" cho `tap_thu_v2` (docs/SPEC_TAP_THU_V2.md §16, yêu cầu #4): chọn model
  riêng cho từng việc (viết prompt video, rà soát + mô tả kho ref, việc lặt vặt, ảnh nhân vật/sheet, ảnh
  bối cảnh/prop, storyboard, chat sửa ảnh) qua danh sách thả xuống có hiện giá cạnh tên, lưu theo series;
  thêm ô "mức suy nghĩ" cho model LLM hỗ trợ; giá model sửa được bằng tay (JSON) trong Cài đặt khi nhà
  cung cấp đổi giá. Model mặc định đổi theo bảng giá owner cung cấp 29/9 (Claude Opus 5.5 cho viết prompt
  video, GPT-6 Luna cho việc lặt vặt...) — sandbox không vào được wavespeed.ai nên chưa tự kiểm tra lại
  được mã model/giá, cần owner xác nhận ở lần chạy key thật đầu tiên. Test bằng API giả, đã chạy
  checks_v2.py + e2e_v2.py pass.
