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
- 2026-09-29 Key và dữ liệu dự án tách khỏi thư mục code cho `tap_thu_v2` (docs/SPEC_TAP_THU_V2.md §17,
  yêu cầu #5): key WaveSpeed/Atlas đọc theo thứ tự tap_thu_v2\keys.txt → ~/.ktoon/keys.txt; thêm ô nhập
  key + nút "Lưu key" trong Cài đặt (chỉ hiện ****4 số cuối, không ghi log/state). Ảnh/video/state/chi phí
  chuyển sang 1 thư mục dữ liệu riêng (mặc định ~/KTOON_DATA, đổi được trong Cài đặt, cần khởi động lại
  app). Từ nay commit/push thẳng lên main khi test API giả pass, không mở PR nữa. Test bằng API giả, đã
  chạy checks_v2.py + e2e_v2.py pass (script test cũng cập nhật để dữ liệu test nằm gọn trong thư mục
  test, không lẫn vào thư mục dữ liệu thật).
- 2026-09-29 Tự cập nhật code từ GitHub cho `tap_thu_v2` (docs/SPEC_TAP_THU_V2.md §18, yêu cầu #6): app tự
  hỏi GitHub mỗi 2 phút, có commit mới trên main thì tự tải, thay đúng 5 file code (không đụng key/dữ
  liệu), mở tiến trình mới ở cổng kế tiếp, đợi tiến trình mới chạy được rồi mới tắt tiến trình cũ — tiến
  trình đang chạy không bao giờ bị gián đoạn bởi 1 bản cập nhật lỗi (bản lỗi tự quay lại bản cũ, báo trên
  giao diện). Thêm ô GitHub token (chỉ đọc) + tên repo trong Cài đặt (lưu như key, chỉ hiện 4 số cuối),
  dải nhỏ hiện phiên bản đang chạy, nút "Kiểm tra cập nhật ngay", và trang tự chuyển/tự tải lại khi có bản
  mới (trừ khi đang gõ dở). Test bằng GitHub API giả mới thêm vào mock_providers.py
  (`ktoon_tap_thu/tests_mock/update_check.py`) — cả đường thành công lẫn đường rollback đều pass ổn định.
- 2026-09-29 Thư viện kiến thức cho `tap_thu_v2` (docs/SPEC_TAP_THU_V2.md §19, yêu cầu #7): mục mới để
  tải file (.txt/.md/.docx/.xlsx) hoặc dán text, gắn 1 trong 8 loại (shotlist/kịch bản, ảnh nhân vật,
  char sheet, bối cảnh, prop, storyboard, prompt video, style), lưu trong thư mục dữ liệu, có phiên bản
  và quay lại bản cũ được. Các bước tách tập/chia batch, tạo ảnh, viết prompt video tự chèn đúng loại
  tài liệu vào system prompt; ô "Prompt mẫu" cũ vẫn ưu tiên nếu có dán, không thì dùng thư viện. Tài
  liệu dài hơn ~3.000 từ có nút "Rút gọn thành bộ luật" (LLM việc lặt vặt) — chỉ dùng bản đã duyệt, bản
  gốc giữ nguyên; hiện số token ước tính mỗi lần gọi. Mỗi ảnh/prompt tạo ra ghi rõ tài liệu + phiên bản
  đã dùng. Test bằng API giả (`ktoon_tap_thu/tests_mock/knowledge_check.py`, 19 bước) cộng
  `checks_v2.py` + `e2e_v2.py` + `update_check.py` chạy lại đều pass.
- 2026-09-29 Thư viện kiến thức — bản chốt cho `tap_thu_v2` (docs/SPEC_TAP_THU_V2.md §20, yêu cầu #7 bản
  chốt, thay cho §19 ở chỗ mâu thuẫn): tải/dán tài liệu không cần gắn loại — "Thủ thư" (GPT việc lặt vặt)
  tự chia đoạn và gán vào 13 khe (quy tắc shot list — dùng chung mọi dự án, chỉ dẫn hệ thống dự án, mẫu
  điền việc, ảnh nhân vật/sheet/bối cảnh/prop, cách viết + ví dụ prompt video, nối cảnh, sửa ảnh, nhận
  xét, QC); owner xem/sửa/duyệt bảng "đoạn → khe", 2 tài liệu cùng khe thì báo mâu thuẫn cho chọn, up lại
  cùng tên tài liệu chỉ báo chỗ đổi. Kiến thức lưu theo dự án (`KTOON_DATA\projects\<dự án>\kien_thuc`),
  riêng tài liệu quy tắc shot list là kiến thức chung mọi dự án. Kịch bản → shot list (dùng khe quy tắc
  shot list, bỏ qua được nếu đã có shot list) → chia batch theo từng "# SEQUENCE" (không cắt ngang cảnh/
  lời thoại) → viết prompt video tự điền hết {{...}} của mẫu task_form (không bắt owner điền); gửi cả
  ảnh đơn (khoá mặt) + char sheet (chỉ tham khảo góc/trang phục, không dùng làm khung hình đầu) khi sinh
  video, chọn được chỉ 1 trong 2 theo từng batch để so sánh. Char sheet theo đúng quyết định của owner
  (nền trắng đơn, không theo tài liệu nếu tài liệu ghi khác). Cảnh báo (không tự cắt) khi thoại dài hơn
  shot (2.3 từ/giây + thời gian thở). Ngưỡng rút gọn tài liệu tăng lên ~6.000 từ. Test bằng API giả với 2
  tài liệu mẫu giống cấu trúc owner đưa (`ktoon_tap_thu/tests_mock/knowledge_check.py`, viết lại thành 55
  bước) cộng `checks_v2.py` + `e2e_v2.py` + `update_check.py` chạy lại trên instance mới đều pass.
