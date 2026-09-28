# Hướng dẫn cho Trường — bắt đầu với Claude Code

Thư mục này đã có sẵn hồ sơ dự án. Bạn không cần đọc phần kỹ thuật, chỉ cần làm theo 6 bước.

## Trong thư mục có gì
- `CLAUDE.md` — bản nội quy Claude Code phải tuân theo (luật về tiền, cấm dùng mặt người thật,
  luôn trả lời bạn bằng tiếng Việt...).
- `docs/BRIEF.md` — toàn bộ thiết kế sản phẩm: kiến trúc, 4 vai trò, 4 cổng duyệt, bảng giá thật,
  các rủi ro và cách xử lý.
- `docs/M0_SMOKE_TEST.md` — việc đầu tiên: chạy thử API để lấy số liệu thật, trần chi 5 USD.
- `docs/PROMPT_RULES.md` — các khung prompt Seedance 2.5 của bạn, đã viết thành luật cứng.
- `.env.example` — chỗ để điền API key (sẽ làm ở bước 4).

## Bước 1 — Cài Claude Code (một lần duy nhất)
1. Bấm phím Windows, gõ `PowerShell`, mở **Windows PowerShell**.
2. Dán dòng này rồi Enter, chờ chạy xong:
   irm https://claude.ai/install.ps1 | iex
3. Đóng cửa sổ đó, mở **một cửa sổ PowerShell mới**, gõ:
   claude --version
   Thấy hiện số phiên bản là cài thành công. Nếu báo không tìm thấy lệnh, nhắn mình.

Lưu ý: Claude Code cần tài khoản Claude gói Pro hoặc Max (gói miễn phí không dùng được).

## Bước 2 — Mở Claude Code trong thư mục dự án
1. Mở File Explorer, vào đúng thư mục:
   D:\KToonS\AI_PROJECT\PROJECT_VIBE CODE_TOOL PRODUCT\02_PRODUCTION
2. Bấm chuột vào thanh địa chỉ ở trên cùng, xóa hết, gõ `powershell` rồi Enter.
   Một cửa sổ đen mở ra, đang đứng sẵn trong thư mục dự án.
3. Gõ:
   claude
   Lần đầu nó sẽ mở trình duyệt để bạn đăng nhập tài khoản Claude. Đăng nhập xong quay lại.

## Bước 3 — Câu đầu tiên dán vào Claude Code
Dán nguyên đoạn này:

Đọc CLAUDE.md, docs/BRIEF.md, docs/PROMPT_RULES.md và docs/M0_SMOKE_TEST.md. Trả lời tôi bằng
tiếng Việt, tôi không biết code nên hãy nói thật đơn giản. Bắt đầu từ M0. Trước khi chạy bất cứ
thứ gì tốn tiền, liệt kê cho tôi những thứ bạn cần tôi chuẩn bị. Không tiêu quá 5 USD.

## Bước 4 — API key (làm khi Claude Code yêu cầu)
Đừng dán API key vào khung chat của bất kỳ ai, kể cả mình. Cách an toàn:
1. Trong thư mục dự án, copy file `.env.example` thành file mới tên `.env`.
2. Mở `.env` bằng Notepad, dán key vào sau dấu `=` ở dòng `WAVESPEED_API_KEY=`, lưu lại.
3. Nói với Claude Code: "đã điền key vào .env".

Không chụp màn hình file `.env`. BytePlus ModelArk để sau, khi có thẻ quốc tế; hiện tại chỉ cần key
WaveSpeed.

## Bước 5 — Bạn kiểm soát cái gì
Hệ thống tự chạy, nhưng dừng lại hỏi bạn ở 4 cổng:
1. Bible + danh sách tập + shot list tập mẫu
2. Bộ nhân vật và bối cảnh
3. Bản dựng của tập
4. Gói phát hành

Và hai cái phanh về tiền: 40 USD mỗi tập, 190 USD mỗi tháng. Chạm trần là dừng, hỏi bạn.

## Bước 6 — Khi có gì lạ
Chụp màn hình hoặc copy đoạn báo lỗi gửi cho mình ở đây. Mình sửa hồ sơ dự án rồi bạn bảo
Claude Code đọc lại. Hai bên dùng chung thư mục này nên không bị lệch.

## Việc tiếp theo của mình
Sau khi M0 chạy xong và có số liệu thật, mình sẽ cập nhật lại bảng chi phí trong `docs/BRIEF.md`
và nói cho bạn biết một tập thật sự tốn bao nhiêu, rồi mới cho Claude Code build tiếp M1.

## Trợ lý AI trong tool (mới, 27/9)
Bên phải màn hình có tab **Trợ lý**: một khung chat hiểu toàn bộ dự án (các tập, shot, diễn viên,
bối cảnh, tiền đã chi) và biết bạn đang chọn shot nào. Hỏi hoặc giao việc bằng tiếng Việt, ví dụ
"Viết prompt Seedance cho EP01_S05" hay "Vì sao S07 bị lệch mặt, sửa thế nào?".
- Trợ lý được tự sửa nội dung (mô tả, prompt, thời lượng, thêm shot), luôn kèm nút **Hoàn tác**.
- Việc tốn tiền (tạo ảnh, video), duyệt hay trả về: trợ lý chỉ đưa ra một thẻ đề xuất có ghi giá.
  Chỉ khi bạn bấm **Đồng ý** thì mới chạy.

**Dùng thử ngay:** mở bản thử KTOONSTUDIO trong Claude (link trong chat). Bản thử chạy bằng tài khoản
Claude của bạn, không tốn tiền WaveSpeed. Lần đầu Claude sẽ hỏi bạn có cho phép không.

**Tool thật cần API key riêng.** Key này tính tiền theo lượt dùng, khác với gói Claude Pro hay ChatGPT Plus.
- Claude: tạo key ở platform.claude.com/settings/keys, nạp trước một khoản nhỏ (ví dụ 5-10 USD).
- GPT (không bắt buộc): tạo key ở platform.openai.com/api-keys, cũng nạp trước.
- Dán key vào file `.env` ở dòng `ANTHROPIC_API_KEY=` hoặc `OPENAI_API_KEY=`, làm như bước 4.
  Không dán key vào khung chat, không chụp màn hình file `.env`.

Chi phí ước tính: khoảng 500 đồng một câu hỏi thường (Claude Sonnet). Trần mặc định cho trợ lý là
15 USD/tháng, nằm trong trần chung 190 USD/tháng.
