# KTOONSTUDIO — Workspace UI brief (v2, 2026-09-27)

Owner's decisions (Vietnamese summary): tên tool là KTOONSTUDIO; giao diện là một không gian
canvas: cuộn chuột = thu phóng, chuột phải kéo = di chuyển màn hình, chuột trái = chọn và sắp xếp.
Bản trước bị chê "phèn" và thừa thông tin.

Reference implementation of every interaction below: `docs/ui/ktoonstudio_prototype.html`
(vanilla JS, no build step — port its interaction code, do not reinvent it).

## Interaction model (must match exactly)
- Mouse wheel = zoom anchored at the cursor, clamp 10%–300%; trackpad pinch (wheel + ctrlKey) too.
- RIGHT button drag = pan. Browser context menu suppressed on the canvas.
- LEFT click = select; LEFT drag on an object = move (snap 8 px on release); LEFT drag on empty
  canvas = marquee selection; Shift+click toggles.
- Movable: episode frames. Sequences are an auto-layout row in story order, never free-positioned:
  drag a sequence left/right to reorder it; drag a shot to reorder it or move it to another sequence.
  Timecodes and "Phân đoạn N" titles are derived from order and durations, never typed. A sequence
  that grows pushes the next ones right; an episode that grows pushes the episodes to its right; an
  episode dropped on another slides below it. Nothing may ever overlap (owner-reported bug, fixed
  2026-09-27 — keep an automated overlap check).
- Double-click a shot = open inspector. Esc = close inspector, then clear selection.
- Space + left drag = pan. F = fit all. 0 = 100%. V / H = select / hand tool.
- Drag a character or location from the cast tray onto a shot or a whole sequence = assign.
- A = approve selected shot(s). R = send back with a reason (inline input + quick chips:
  Mặt lệch, Tay lỗi, Sai bối cảnh, Khẩu hình). Never alert/confirm/prompt.

## Semantic zoom (progressive disclosure)
- < 35%: episode frames collapse to a title + one status strip (one segment per shot).
- 35–90%: sequences with 9:16 thumbnails and one small status mark per shot.
- > 90%: shot code, duration, one-line action, cast avatars.
Costs and retake counts never appear on the canvas — only in the inspector and budget popover.

## Chrome (floating, minimal)
Top-left: wordmark + breadcrumb. Top-right: ONE budget pill (episode spend / cap) with popover
(episode, month, last charges). Left: collapsible episode rail. Bottom-left: collapsible cast &
location tray. Bottom-centre: tool dock (Chọn, Kéo màn hình, Thêm shot, zoom %, "Chạy tập" — the
only accent-filled button) + "N đang tạo" jobs indicator. Right: one docked panel with two tabs, Shot | Trợ lý, only when open. Topbar: "Trợ lý" button left of
the budget pill.
"Chạy tập" queues KEYFRAMES only; video runs after images are approved (image-first rule).

## Visual system
Cool graphite neutrals (dark) / cool paper (light), one accent (#7F8DFF dark, #3A4ED6 light),
hairline borders, 10–12 px radius, shadow only on floating panels. Status = 5 marks that differ
in shape: dashed ring (chưa có keyframe), spinning arc (đang tạo), dot (cần xem), check (đã duyệt),
cross (lỗi). Fonts: Be Vietnam Pro (UI), JetBrains Mono (codes/timecodes only), Unbounded
(wordmark only). No gradients, glows, emoji or badges-on-badges.

## Prompt to give a design model (e.g. Fable) for a further redesign
Use this file as the brief, attach docs/ui/ktoonstudio_prototype.html, and ask it to keep the
interaction model and semantic zoom exactly, while improving visual polish only.

## v2 refinements (2026-09-27) — evidence from shipped products
| Source | What they learned | What we adopted |
|---|---|---|
| Figma UI3 (figma.com/blog/our-approach-to-designing-ui3) | Floating panels were reverted to fixed panels after beta: they cramped the canvas, showed content behind panels and slowed people down. Kept a Minimize-UI mode. | Left sidebar and right inspector are DOCKED grid columns, never floating over the canvas. `\` collapses both. Canvas content stays still when a panel toggles. Bottom tool dock stays floating. |
| Linear redesign (linear.app/now/how-we-redesigned-the-linear-ui) | LCH colour: few base variables generate the theme; higher text contrast; less accent; strict alignment. | All colours in OKLCH from one base hue (262); statuses at equal perceptual lightness; accent only on the run button, selection and focus. |
| LTX Studio | Storyboard-first: review shots before spending on generation; characters as reusable Elements referenced with @Name. | Stage switch **Keyframe / Video** (keys 1/2). In Video, shots without an approved keyframe are locked. Cast names in actions render as @mentions. |
| Frame.io V4 | Version stacking and side-by-side comparison for review. | Takes are versions (v1…vN) shown as a stack on the card; inspector lists versions and compares the last two, "Dùng bản này" picks the winner. |
| Figma Weave | Cost per model shown where you run it; pick-the-winner step; simplified app mode. | Run button states count + cost; a confirmation popover shows total, episode spend vs cap, and blocks runs that would exceed the $40 cap. |
| Figma contextual toolbars / Fitts's law | Put actions next to the object. | A contextual bar appears above the selected shots: Duyệt, Trả về (reason chips), Tạo lại, Chi tiết. |
| Figma, Linear | Shortcut sheet. | `?` opens the shortcut sheet. |

## Trợ lý AI panel (v3, 2026-09-27)
Reference: `docs/ui/ktoonstudio_prototype.html`, section "AI assistant". Engineering spec: BRIEF.md 8.1.
- Placement: tab "Trợ lý" in the docked right panel, next to "Shot". Entry points: topbar button
  "Trợ lý", key `/`, the chat icon in the contextual bar above selected shots, and "Nhờ trợ lý viết
  prompt" in the shot inspector when a shot has no prompt.
- Context chips above the input ("Trợ lý đang xem EP01_S05 · Video") follow the canvas selection live.
  Each sent message stores the selection it was sent with, shown under the bubble.
- Empty state: 4 suggestions computed from the state (prompt for the selected shot; why the first
  sent-back shot failed; continuity of the episode; money left to finish) + one line on cost and
  permissions. No fake history.
- Messages: owner = right-aligned bubble; assistant = full-width text in a safe markdown subset
  (paragraphs, bullets, numbered lists, bold, inline code, code blocks with "Chép"). Shot codes
  (EP01_S05, S05) render as links that select and pan to the shot. Tool effects render as activity
  rows ("Đã sửa prompt của EP01_S05 · Hoàn tác"). Paid or gate actions render as a proposal card:
  title, codes, cost, episode spend before -> after, [Bỏ qua] [Đồng ý · ~$X]; accept is disabled when
  the run would cross the cap.
- Progress: "Đang nghĩ · 12s" until the first text (after 15 s add "chế độ Chuẩn có thể mất tới 1
  phút"), a caret while streaming; Send turns into Stop. Errors inline in plain Vietnamese; "Thử lại"
  only where retrying makes sense; never auto-retry.
- Composer: auto-growing textarea (max ~8 lines); Enter sends, Shift+Enter adds a line; ignore Enter
  while an input method is composing (Vietnamese IME). Mode picker "Claude · Chuẩn": Nhanh / Chuẩn /
  Kỹ, then the providers that have a key. New-chat icon in the panel's tab bar.
- Real tool only: each reply shows its cost and model ("~$0.02 · Sonnet 5").
- Phone width: both side panels overlay the canvas and span the whole content row (left drawer, right
  bottom sheet at 76% height); the topbar drops the wordmark, minimize and shortcut buttons.
