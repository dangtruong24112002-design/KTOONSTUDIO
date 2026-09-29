# SPEC — Tập thử v2: sequence 30 s + Omni Reference (locked 2026-09-28)

## 1. Why
The owner must validate, on ONE real 90-second episode, the workflow he already uses by hand in Dreamina
(Seedance 2.5 Omni Reference, 30-second generations), now through APIs. He needs real numbers for cost,
quality, and time before committing to a paying 60-episode contract. The client pays 50M VND. The target
cost is ≤ 30M VND, about $19 per episode.
Build the smallest app that runs this end to end and is easy to fix. Simple beats complete.

## 2. Deliverable
New folder `tap_thu_v2/`. Do NOT modify `studio/`: the M1 codebase is paused.

Technical requirements:
- Python 3.8+, standard library only.
- Runs on Windows 10/11 and macOS.
- Local web UI in Vietnamese, plain words, opened in the browser.
- Start from `ktoon_tap_thu/ktoon_tap_thu/app.py` + `ui.html`. That is v1: an episode app built and tested
  on 2026-09-28 with job queue, resume after restart, budget guard, balance-based price probe, CSV ledger,
  and a server bound to 127.0.0.1 with token + Host check.
- Reuse the offline kit in `ktoon_tap_thu/tests_mock/`.
- Target size: about ≤ 1,800 lines of Python + one HTML file.
- Ship the same files as v1:
  - `chay_windows.bat` and `chay_mac.command`.
  - `HUONG_DAN.txt`, short and in Vietnamese.
  - `keys.txt`, created as an empty template if missing. It holds `WAVESPEED_API_KEY`, `ATLASCLOUD_API_KEY`
    and `BUDGET_USD`. It is gitignored. Never print, log, or store key values anywhere else.

## 3. Owner's workflow (source of truth — automate it, do not redesign it)
**Pre-production**, which the owner calls the most important stage:
- **Input:** the episode script or summary text.
- **Character:**
  - The owner mixes components from reference images, e.g. hair from image 1, eyes from image 2, body from
    image 3. The result is ONE character on a solid white background.
  - That image then becomes a 21:9 reference sheet on a solid white background:
    - right 70%: 4 full-body views (front, 3/4, side, back);
    - left 30%: 4 face views.
  - Upscaled to 2K or 4K.
- **Environment:** one wide or ultra-wide establishing image per location, plus an English text block.
  Recommend also a reverse angle.
- **Prop:** one image each.
- **Voice:**
  - A 5–6 s audio clip per character, cut from an earlier generated clip.
  - Used ONLY as a voice-timbre reference.
- **Video ref:** real film clips, used only as motion/camera reference, for hard scenes only.

**Production:**
- **Reference Bank and prompts:**
  - GPT builds a Reference Bank from the images and analyses the film style.
  - It writes one Omni Reference prompt per generation from the shot list, citing @Image / @Audio / @Video.
  - Prompts are then reviewed against the shot list.
- **Generation length:**
  - ONE generation = 30 s, to keep context and continuity (raccord).
  - One location/sequence per generation.
  - The next generation either opens on a close-up/filler shot or re-describes the previous raccord.
- **QC per generation:**
  1. sharp, and character identity consistent;
  2. correct raccord with the previous and next generation;
  3. correct voice and a fitting expression.
- **Fix:**
  - Export the broken frame and fix it into a storyboard image.
  - Regenerate ONLY the broken part, with the fixed image as an extra reference.
- **Attempts:** today it takes 2 attempts per generation on average.

**Post-production:**
- Clips are downloaded in order and edited in Premiere.
- Music: the owner's own files or Suno. Text is added in post. No subtitles in the video.

**Hook:**
- The first 3 s must be the strongest.
- It may contain non-explicit sensual content: skin shown, intimate areas covered, adults only.

## 4. Decisions (locked with the owner)
1. **Faces from AI images only.** Real photos may be used only for costume, hair, body, or pose components.
   - Every uploaded component carries `source: ai|real` and `use: face|eyes|hair|costume|body|pose|other`.
   - The app refuses `real` + `face|eyes`.
2. **Episode = 3 sequences of about 30 s.**
   - **S1** (0–30 s, contains the hook) and **S3** (60–90 s, cliffhanger): Seedance **2.5** reference-to-video,
     30 s.
   - **S2**: Seedance **2.0** reference-to-video, as two 15 s parts. Part b adds part a's last frame as an
     extra reference image, plus raccord text.
   - If the LLM tags S2 `key` (twist, reveal, confrontation), propose 2.5 for it.
   - The owner can switch the model of any sequence with one click before generating.
3. **Money rules:**
   - Cap $18 per episode (setting). For the first test episode the owner may raise `BUDGET_USD` to about
     $30, because it also pays for reference sheets and price probes.
   - Max **2 full generations** per sequence. After that, only partial fixes of 4–10 s.
   - Every paid step shows its estimate and needs a click.
   - The first generation of each video model runs alone and measures the real price from the Atlas balance
     (v1 already does this). If measured 2.5 is above $0.16/s: warn, and switch the default to
     "only S1 on 2.5".
4. **No TTS and no lip-sync.** Voices come from `reference_audios`.
5. **Moderation:**
   - If a provider refuses a request, mark the sequence `bị chặn` and show the provider message.
   - Let the owner pick another model for that sequence.
   - Never add prompt tricks to evade moderation.

## 5. Screens (tabs), in this order
1. **Dự án**
   - Project name, episode number, script text (paste).
   - "Phân tích style" (GPT) produces an editable style block.
2. **Tham chiếu** (Reference Bank): characters, environments, props, voices, video refs.
   - **Character:**
     - Upload components with tags.
     - "Tạo nhân vật" calls Nano Banana Pro edit, 3:4, white background. The owner approves.
     - "Tạo sheet 21:9" calls Nano Banana Pro edit: input = the approved image, prompt = the layout in §3,
       2k by default, 4k optional. The owner approves.
     - Uploading a finished sheet directly must also work. The owner already has sheets.
   - **Environment:** text block + "Tạo ảnh wide" (optional reverse angle), or upload.
   - **Voice:**
     - Upload a WAV or MP3 of 2–15 s. Warn if longer than 6 s.
     - Optional "Cắt từ clip" (clip + start second), which needs ffmpeg.
   - Every asset is saved under the owner's naming (§6) with a version. Only the approved version is used.
3. **Sequences**
   - GPT splits the script into 3 sequences, returned as JSON.
   - Each sequence contains:
     - time range and location;
     - characters and props;
     - beats with timestamps;
     - English dialogue lines, each with its speaker;
     - tag `hook|normal|key|cliffhanger`;
     - raccord-in and raccord-out notes;
     - the video refs it needs.
   - Editable as a simple form or as JSON.
4. **Prompt**
   - GPT writes one prompt per generation (S1, S2a, S2b, S3) using the formula in §7.
   - The APP builds the reference lists and their numbering, and gives GPT the mapping, e.g.
     `@Image1 = Char_Ethan sheet; @Audio1 = Ethan voice`. GPT never guesses numbers.
   - Gemini reviews each prompt against the sequence JSON and returns pass or notes.
   - The owner approves or edits.
5. **Gen & QC**
   - Run all generations. S2b waits for S2a's last frame.
   - Each result shows: a player, the 3 QC checkboxes, a note field, Pass/Fail, and a full-attempt counter
     (max 2).
6. **Sửa đoạn hỏng**
   - Pick a clip and a start/end second, 4–10 s.
   - The app extracts the frame (ffmpeg).
   - The owner types the fix; Nano Banana Pro edit applies it; the owner approves.
   - The app regenerates only that segment: same references + the fixed frame, a prompt limited to that time
     range, duration = end − start (minimum 4).
   - The result is saved as a patch clip with its timecodes.
7. **Xuất**
   - Copy clips and patches into `export/EP<nn>/` in order, with the owner's naming.
   - Write `danh_sach.txt`: the order, plus the timecodes where each patch goes.
   - Joining clips is not required (optional if ffmpeg exists).
8. **Chi phí**
   - For each generation, model and attempt: estimate and measured cost (from the balance).
   - Totals, and a ×60 projection in VND (26,170 VND/USD) against the 30M target and the $18 cap.

## 6. Naming and folders (owner's convention)
Root: `tap_thu_v2/projects/<DuAn>/`

| Folder | File name |
|---|---|
| `01_PreProduction/01_Script/` | `SCRIPT_<DuAn>_EP<nn>_v<n>.txt` |
| `01_PreProduction/02_Environment/` | `Envi_<Ten>_<INT\|EXT>_<2K\|4K>_v<n>.<ext>` |
| `01_PreProduction/03_Character/` | `Char_<Ten>_<DacDiem>_<2K\|4K>_v<n>.<ext>` |
| `01_PreProduction/04_VideoRef/` | `Video_Ref_<MoTa>_v<n>.mp4` |
| `01_PreProduction/05_Prop/` | `Prop_<Ten>_<2K\|4K>_v<n>.<ext>` |
| `01_PreProduction/06_Voice/` | `Voice_<Ten>_v<n>.<wav\|mp3>` |
| `02_Production/EP<nn>/` | `<DuAn>_EP<nn>_Video_S<k>_<101>_v<n>.mp4`; patches: `..._patch_<a>-<b>s_v<n>.mp4` |
| `export/EP<nn>/` | ordered copies of the above + `danh_sach.txt` |

## 7. Prompt formula (owner's Seedance 2.5 Enterprise guide; English prompts)
**MASTER formula.** Four parts:
- **[Creatives Description]**
- **[One-sentence Summary]:** Subject + Location + Event + Theme/Style + Special camera movement.
- **[Plot per timestamp]:** picture + camera + action + dialogue + SFX, followed by the negatives.
- **[Global supplement]:** repeat the camera position, environment features, sound/atmosphere and lighting;
  repeat the prohibited items.

**30-second video: three modules.**
- **M1 reference layer.** Example:
  `Based on the uploaded references, strictly maintain the face and features of @Image1 for Ethan, the
  composition and space of @Image3, the voice timbre of @Audio1 for Ethan; strictly lock character
  positions.`
- **M2 global settings / anti-collapse:** environment + texture, visual style, shot language, character
  styling, performance core, prohibited items.
- **M3 timestamp storyboard:** each slice = [a–b s] + phase + action/expression/composition + camera
  scheduling.

**Always end with the prohibited list:**
- no subtitles, no BGM;
- no exaggerated movements, no extra dialogue;
- no runny nose or premature tears;
- no AI-feel artifacts;
- no fast cuts, when the generation is one continuous shot.

**Characters:** use the 7-dimension formula in `docs/PROMPT_RULES.md`: age/race, skin with "retain true
micro pores and skin texture", facial details, eyes/soul, hair, clothing, body/mood.

## 8. APIs (read from provider pages 2026-09-28 — re-verify on the first real run)
**Atlas Cloud** (video). Auth: `Authorization: Bearer ATLASCLOUD_API_KEY`.
- **Generate:** `POST https://api.atlascloud.ai/api/v1/model/generateVideo`, body `{model, prompt, ...}`
  → `data.id`.
- **Poll:** `GET /api/v1/model/prediction/{id}` → `data.status` (completed/failed), `data.outputs[0]`.
- **Upload local files:** `POST /api/v1/model/uploadMedia`. The shape is NOT verified. Check the docs, and
  whether `reference_*` also accept base64.
- **Balance:** `GET https://api.atlascloud.ai/public/v1/balance` → `available.value` (a USD string).
- **Refunds:** failed generations are refunded.

**Seedance 2.5 reference-to-video** — `bytedance/seedance-2.5/reference-to-video`:
- `reference_images`: up to 30. Aspect 0.4–2.5, so 21:9 is OK; 300–6000 px; < 30 MB.
- `reference_videos`: up to 10. 2–30 s each, ≤ 30 s in total, ≤ 200 MB.
- `reference_audios`: up to 10. WAV/MP3, 2–30 s each, ≤ 30 s in total, ≤ 15 MB.
- In the prompt, cite `@Image1`, `@Video1`, `@Audio1` in submission order.
- `duration`: 4–30 or -1.
- `resolution`: default `720p`.
- `ratio`: `9:16`.
- `generate_audio`: true. `watermark`: false.
- `return_last_frame`: true. Find where the frame URL appears in the response.
- `omni_reference_task_type`: auto | reference | edit | extend. `edit` needs duration -1.
- Listed price: $0.134/s. References are not charged. The price per resolution is NOT published; the probe
  must measure it.

**Seedance 2.0 reference-to-video** — `bytedance/seedance-2.0/reference-to-video`:
- Up to 9 images, 3 videos (2–15 s total), 3 audios (2–15 s total).
- Duration 4–15 s.
- The page shows the prompt syntax as `image 1`. Check whether `@Image1` also works.
- Listed price: $0.09/s.

**Real-person likeness:** Atlas terms allow it only with the person's authorization, and no impersonation.

**WaveSpeed** (images + LLM). Auth: `Authorization: Bearer WAVESPEED_API_KEY`.
- **Media:** `POST https://api.wavespeed.ai/api/v3/<model>` → `data.id`.
  Result: `GET /api/v3/predictions/{id}/result` → `data.status`, `data.outputs[0]`.
  Balance: `GET /api/v3/balance` → `data.balance`.
- **Media upload:** WaveSpeed has an upload endpoint (check `/api/v3/media/upload/binary`).
- **Nano Banana Pro edit** — `google/nano-banana-pro/edit`:
  - Body `{prompt, images (≤14 URLs), resolution: 1k|2k|4k, aspect_ratio: "21:9"|"9:16"|"3:4"..., output_format}`.
  - Price: $0.14 at 1k/2k, $0.24 at 4k.
  - Text-to-image variant: `google/nano-banana-pro/text-to-image`.
- **LLM:** `POST https://llm.wavespeed.ai/v1/chat/completions`, OpenAI format.
  - `openai/gpt-5.5`: $5 / $30 per 1M tokens (a reasoning model).
  - `google/gemini-3.6-flash`: about $0.75 / $3.8. `google/gemini-3.7-flash`: $1.5 / $7.5.
  - `response_format: {"type":"json_object"}` is supported.
  - Check whether image inputs (OpenAI content parts) work. If not, use a text-only Reference Bank:
    descriptions that the owner approves.

## 9. Engineering rules
- **Budget guard before every paid call**; estimate first, then compare with the balance.
- **Resumable:** `state.json` is written atomically. In-flight jobs are polled again after a restart and
  never resubmitted.
- **Record-keeping:** a ledger CSV (`so_chi.csv`) and a log (`nhat_ky.txt`). Scrub keys from every message.
- **Downloads:** download outputs immediately, because provider URLs expire.
- **ffmpeg is optional.** Detect it. Features that need it (frame extract, voice cut, optional join) show a
  one-line install hint (`winget install Gyan.FFmpeg`) when it is missing.
- **Keep it small and readable:** one file for providers, one for the pipeline/state, one for the server, one
  HTML file. No frameworks.

## 10. Tests (never call real APIs from the cloud)
- **Extend `ktoon_tap_thu/tests_mock/mock_providers.py` with:**
  - Atlas reference-to-video for both models: accept the reference arrays; `return_last_frame` returns a
    last-frame URL.
  - uploadMedia.
  - Balances that move with charges.
  - Nano Banana Pro edit.
  - LLM: canned style block, sequence JSON, prompts, and review.
- **Playwright e2e, happy path:**
  1. Reference Bank: upload a sheet + voice; also create one character via the API.
  2. Sequences.
  3. Prompts, reviewed.
  4. Gen with probe.
  5. One QC fail, then a partial fix.
  6. Export.
  7. Cost tab.
- **Also test:**
  - the $18 cap blocks spending;
  - the 3rd full generation is blocked;
  - `real` + face is refused;
  - no key value ever appears in state, log, ledger or UI;
  - a restart resumes in-flight jobs;
  - S2b waits for S2a's last frame.

## 11. Done when
- The e2e tests pass.
- The owner can double-click the launcher on Windows.
- `HUONG_DAN.txt` is updated.
- A PR is open with a short Vietnamese summary. It says what was built, how to run it, and what to check on
  the first real run (§12).

## 12. Open items only real keys can answer (first real run)
- The real price at 720p of 2.5 reference-to-video and of 2.0 reference-to-video (probe).
- The shape of Atlas uploadMedia, and base64 support.
- The 2.0 prompt syntax.
- The `return_last_frame` field.
- Whether the WaveSpeed LLM accepts image inputs.
- Whether sensual-but-covered hook prompts are refused.
- How long output URLs live.

## 13. Addendum (2026-09-29) — owner-supplied shot list, auto pre-production list, storyboard
Locked with the owner on 2026-09-29. Extends, does not replace, §5-§7.

1. **Owner input first.** The Sequences screen accepts a pasted shot list (plain text or a table copied
   from Excel/Docs) alongside the script. When shots are pasted, GPT normalizes them into the app's shot
   schema (`id`, `duration`, `location`, `cast`, `props`, `desc`, `speaker`, `line`) **without changing the
   shot count or order** — it is a parser here, not a writer. GPT only invents a fresh shot list (16-20
   shots, as in `docs/M0_SMOKE_TEST.md`/v1 style) when the owner pastes nothing.
   A second GPT call groups the existing shots into exactly 3 sequences of about 30 s (S1 hook, S2 normal
   or key, S3 cliffhanger), assigning each shot whole to one sequence — it returns shot-id groupings only,
   never rewrites a shot. The app derives each sequence's `time_range`/beats/location/cast/props from its
   assigned shots' own fields, so continuity data is never invented twice.
2. **Automatic pre-production list.** From the script and the shot list, one GPT call proposes the
   Reference Bank's characters, environments (with `INT|EXT` and `day|night`) and props, each with a short
   English description. Items land in the bank marked **not approved** (a badge in the UI) until the owner
   edits and approves them; manually adding an item (the existing "+" buttons) is still available and is
   approved immediately, as before.
3. **One-button reference image generation.** A single "Tạo ảnh tham chiếu còn thiếu" action estimates
   and (after one approval) generates every missing reference image for every approved bank item:
   - **Character:** if the owner already uploaded a single portrait on a solid white background, go
     straight to the 21:9 sheet (`google/nano-banana-pro/edit`). If there is no portrait yet, generate the
     white-background AI-face portrait first, then the sheet — this is exactly the existing `portrait` →
     `sheet` dependency (§9 job kinds), just triggered together instead of one stage at a time.
   - **Environment:** a wide/ultra-wide establishing image, plus an optional reverse angle, from the
     environment's English text block.
   - **Prop:** a plain white-background image.
   - Every result keeps the naming and folders in §6; each image can still be approved or redone one at a
     time from its own tile (the per-item buttons are unchanged).
4. **Storyboard (per shot).** An owner-toggled per-shot step generates one 9:16 still per shot, composed
   from that shot's character sheet(s) + environment image + its English description. Default model
   `bytedance/seedream-v5.0-flash/edit` (~$0.027/image, the same model v1 already used for keyframes),
   switchable to `google/nano-banana-pro/edit`. An **approved** storyboard image becomes an extra `@Image`
   reference for the sequence its shot belongs to, gated by a per-sequence toggle (default **on**). The
   prompt sent for that generation must say explicitly that the face comes from the character sheet and
   the composition/pose comes from the storyboard, so the model does not average the two together.
5. **Chi phí split.** The Chi phí tab reports two totals: assets made once for the whole series (character
   portraits/sheets, environments, props) versus assets that repeat per episode (shot/sequence LLM calls,
   prompts, storyboard, generation, patches). The ×60 projection in §5.8 only re-multiplies the per-episode
   total; the once-per-series total is added once.

## 14. Addendum #2 (2026-09-29) — per-image chat editing
Locked with the owner on 2026-09-29. Applies to every single reference image: character portrait and
sheet, environment (wide/reverse), prop, and storyboard.

1. Each image has its own chat panel next to it. The owner types a request in Vietnamese or English.
2. Every message: GPT (`openai/gpt-5.5` via the WaveSpeed LLM) rewrites it into a precise English edit
   instruction that always states "keep identity/face/aspect ratio/background unchanged except for..." —
   then that instruction is sent to the chosen edit model against the **currently approved version** of
   the image. The exact English instruction sent is always shown to the owner.
3. The model is chosen in the chat panel itself, one of: `google/nano-banana-pro/edit` (default 2K, 4K
   optional), the WaveSpeed edit variant of GPT Image (verify the exact model id and price against
   WaveSpeed's own listing before the first real run), or `bytedance/seedream-v5.0-flash/edit` (cheap, fast
   iteration). The send button shows the estimated price before it charges anything.
4. Every edit creates a new version (v2, v3, ...) named per §6 — never overwrites. The owner can view any
   past version, compare two versions side by side, and roll back to an older version as the base for the
   next edit. An "Duyệt" (approve) action marks one version as the one used everywhere else in the app
   (Reference Bank picks, storyboard, generation mapping).
5. A chat message can attach a reference image (e.g. "use this shirt"). Every attachment must carry
   `source: ai|real` and `use: ...` like any other component, and the same hard rule applies: a `real`
   source tagged `face` or `eyes` is refused.
6. A "Nhận xét ảnh" (critique) button sends the current image to the LLM and shows what looks wrong (a
   sheet missing an angle, a background that is not white, a broken hand, ...) with **no image-edit
   charge** — only the small LLM viewing cost. If the WaveSpeed LLM turns out not to accept image input
   (open item in §12), this button is hidden rather than shown broken.
7. Chat history and per-message cost are kept per image. A setting (default 10, editable in Cài đặt) caps
   how many edits one image can go through; image-edit spend still counts against the shared budget cap.

## 15. Addendum #3 (2026-09-29) — series-level input, ref library, batches (supersedes conflicts)
Locked with the owner on 2026-09-29: the tool's flow did not match how the owner actually works. This
section **takes priority over §1-§14 wherever they conflict** (in particular: it replaces the fixed
S1/S2a/S2b/S3 structure from §4.2/§13 with flexible per-episode batches, and replaces the "GPT proposes
the pre-production list from the script" default in §13.2 with "the owner supplies a list file that gets
parsed"). Money and safety rules are unchanged: $18/episode cap (owner may raise it for a first test),
max 2 full generations per batch, the first use of each video model still measures its real price, real
faces are still never allowed from a `THAT\` (real-photo) source, keys still load only from `keys.txt`.

### A. Input (series-level: shared across every episode, saved, hand-editable)
1. **Script + shot list.** Upload a file (`.txt .md .docx .xlsx .csv`; read `.docx`/`.xlsx` with the
   standard library only — both are zip archives of XML, so `zipfile` + `xml.etree.ElementTree` read them
   without extra dependencies; a `.pdf` is not parsed — the owner pastes its text instead) or paste text
   directly. The app splits the input into episodes (EP01, EP02, ...). Each episode keeps the owner's own
   shot list exactly: shot count, description, dialogue, and duration where given — the app (or GPT, only
   when asked to merely reformat pasted/uploaded text into the app's shot schema) never invents or drops a
   shot.
2. **Character / environment / prop / style list file.** Upload or paste. The app splits it into
   individual characters, environments, props, and one shared style block (e.g. "ultra realistic 8K
   Hollywood film..."), shown as an editable table for the owner to fix before anything is approved.
3. **Prompt templates**, one set for the whole series, saved and reused for every episode:
   - single white-background character portrait,
   - character sheet 21:9,
   - environment image, prop image (optional),
   - a video-prompt structure document, plus one example video prompt.
   Whenever the app asks GPT to write an actual prompt (a character/environment/prop image, or a batch's
   video prompt), GPT must follow the matching template's structure and voice exactly and change only the
   scene-specific content; the shared style block is always appended.
4. **Reference library.** The owner pastes a local folder path (this app runs on the owner's own machine,
   so the app reads it directly — no browser upload needed). Convention inside that folder:
   - `AI\` — AI-generated images, the only source ever allowed for a face,
   - `THAT\` — real-person photos, usable only for costume, hair, body or pose — **never** face or eyes.
   The app scans the folder once, and for each image not seen before (tracked by path + modified time, so
   an unchanged image is never rescanned) asks a cheap vision-capable model for a short description and a
   `use` tag, then caches the result. If the LLM cannot accept images, the app falls back to labeling from
   the file and folder name. When generating a character, GPT proposes up to about 6 matching component
   images from this tagged library based on the character's description; the owner reviews, swaps, or
   removes any of them by hand before the paid generation runs. The `real`+`face`/`eyes` hard rule applies
   here exactly as it does to a manually uploaded component (§4 item 1): a `THAT\` image can never be
   selected, suggested, or accepted for `face`/`eyes`.

### B. One-click actions (each shows a price estimate and needs one confirmation; every result stays
editable by hand, through the per-image chat, or by redoing it)
5. **[Tạo ảnh đơn tất cả nhân vật]** — per character: the single-portrait template + the shared style
   block + that character's chosen component images → one white-background portrait. The owner approves
   each one (same approve/pick mechanism as today).
6. **[Tạo char sheet cho nhân vật đã duyệt]** — from each approved portrait + the sheet template.
7. **[Tạo ảnh bối cảnh + prop]** — per environment/prop + the shared style block; a reverse angle stays
   optional per environment.
8. **[Chia batch cho tập]** — a deterministic, free (no LLM call) grouping: consecutive shots that share a
   location/sequence are grouped into one generation batch. A batch's length is the sum of its shots'
   durations, capped at 30s (Seedance 2.5) or 15s (Seedance 2.0); a batch never ends mid-line of dialogue.
   The first batch (hook) and the last batch (cliffhanger) default to 2.5; every batch in between defaults
   to 2.0 unless the owner marks it "key" (then it may use 2.5). The owner can merge two adjacent batches,
   split a batch at a shot boundary, and change any batch's model, same as today's per-sequence model
   switch (§4 item 2).
9. **[Viết prompt tất cả batch]** — for every batch, combine its shots with the matching reference images:
   the sheet of every character appearing in the batch, its environment, its props, character voices, any
   video ref, that batch's storyboard image(s) if made (§13 item 4, unchanged), and the previous batch's
   last frame when it is not the episode's first batch (generalizing the old S2a→S2b rule in §4 item 2 to
   every batch boundary in the episode). GPT writes the prompt following the video-prompt structure
   document and example template from §15 item 3; the app still builds and numbers the @Image/@Audio/
   @Video mapping itself (GPT never guesses a number, §7); Gemini still reviews (§5 item 4); the owner
   still approves or edits.
10. **[Gen video hàng loạt]** — submits every approved batch of one episode in one confirmation; a batch
    that needs the previous batch's last frame waits for it automatically. Unchanged from §4 item 3 and
    §9: the first use of each model still measures its real price from the Atlas balance, the $18/episode
    cap still applies, and each batch still gets at most 2 full generations before only the Sửa đoạn hỏng
    patch workflow (§5 item 6, unchanged) can touch it.

### C. Screen
One continuous page, in exactly the order A then B above: the series-level inputs and one-click actions
first, the list of episodes below (each episode expands to its own shot list, batches, prompts, Gen & QC,
Sửa đoạn hỏng and export — §5 items 5-8, unchanged in substance, just scoped per episode and per batch
instead of per fixed S1/S2a/S2b/S3). Plain, non-technical wording throughout, as everywhere else in this
app.

### Testing (still mocks only)
Exercise this with: one sample two-episode script+shot-list file, one sample character/environment/prop/
style list file, and one fake reference library folder containing an `AI\` and a `THAT\` subfolder.
