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

## 16. Addendum #4 (2026-09-29) — model selection in Cài đặt

A new "Cài đặt" (Settings) section, saved at series level (same `settings` object as the rest of the app).
One dropdown per job category, price shown next to each model's name in the option list:

1. **LLM viết prompt video** (the `prompt` stage only) — default `anthropic/claude-opus-5.5`. Options:
   `openai/gpt-6-astra` ($10/$50 per 1M tok in/out), `anthropic/claude-opus-5.5` ($4/$20), `openai/gpt-6-sol`
   ($2/$10), `anthropic/claude-sonnet-5` ($2/$10), `openai/gpt-5.5` ($5/$30). A "mức suy nghĩ" (low/medium/
   high) selector appears next to it, enabled only when the selected model supports it (all five do) —
   sent to WaveSpeed as `reasoning_effort` on the chat-completions body.
2. **LLM rà soát prompt + mô tả kho ref** (the `review` stage, `reflib_scan`, and `critique` — anything
   that needs to look at an image) — default and only listed option `google/gemini-3.6-flash` ($0.75/$3.8).
3. **LLM việc lặt vặt** (`split_episodes`, `parse_list`, `preprod`, `suggest_components`, filling the
   image-prompt templates from §15 item 3, and rewriting a chat edit request into an English instruction)
   — default `openai/gpt-6-luna` ($0.1/$0.5).
4. **Ảnh nhân vật + sheet** (`portrait`, `sheet`) — default `google/nano-banana-pro/edit` (2K $0.14, 4K
   $0.24). Options also include `openai/gpt-image-2/edit` (quality low/medium/high × resolution 1k/2k/4k;
   only `high@2k` = $0.41 is an owner-confirmed price, the other 8 cells default to the same number as a
   safe placeholder — editable), `google/nano-banana-2/edit` (2K $0.105, 4K $0.14), `bytedance/seedream-
   v5.0-pro/edit` ($0.0405). `openai/gpt-image-2/edit` also adds $0.012 per reference image beyond the
   first — applied to portrait generation (the common multi-reference-image case) against the character's
   component count.
5. **Ảnh bối cảnh + prop** (`env_wide`, `env_rev`, `prop`) — same option list as item 4, same default.
6. **Storyboard** — default `bytedance/seedream-v5.0-flash/edit` ($0.0243), selectable from the same list.
7. **Chat sửa ảnh** — the per-message model dropdown (§14 item 3) now draws from the same shared image
   model list/prices instead of a separate hardcoded one.
8. An advanced "Sửa giá model bằng tay (JSON)" field holds `settings.model_prices`, keyed by model id
   (`{"model/id": {"price_in": .., "price_out": ..}}` for an LLM, `{"model/id": {"price": ..}}` or
   `{"price": {"2k": .., "4k": ..}}` for an image model) — the owner edits exactly the models whose price
   changed; everything else keeps the built-in default. All cost math (dry-run estimates and the real
   per-job cost) reads through this override, never the hardcoded default directly.

Model ids/prices above are as the owner read them off WaveSpeed's own pricing page on 2026-09-29; the
cloud sandbox this was built in cannot reach `wavespeed.ai`/`api.wavespeed.ai` (network policy), so this
work could not independently re-verify them against WaveSpeed's live catalog — confirm again on the first
real-key run (§12).

## 17. Addendum #5 (2026-09-29) — keys and project data live outside the code folder

1. **Key loading order**: `tap_thu_v2\keys.txt` wins per-key when it has a value; the home-dir file
   (`Path.home() / ".ktoon" / "keys.txt"`, e.g. `C:\Users\<tên>\.ktoon\keys.txt`) fills in anything the
   local file doesn't have; `.env` is a last-ditch legacy fallback. A "Cài đặt" panel has 2 password-style
   fields (WaveSpeed, Atlas) + a "Lưu key" button: it writes to the home-dir file, and also mirrors into
   the local `tap_thu_v2\keys.txt` if that file exists (so the save is never silently shadowed by an
   existing local file's own value, given the read priority above). The field only ever displays the
   saved key as `****<last 4 chars>` — never the full value — and the key is never written to `state.json`
   or any log line.
2. **Project data folder**: images, video, `state.json`, `so_chi.csv`, `nhat_ky.txt`, `export/` all live
   under one `DATA_DIR`, default `C:\Users\<tên>\KTOON_DATA`, separate from the `tap_thu_v2` code folder —
   so replacing the code (by hand, or by the self-updater in §18) never touches project data. `DATA_DIR`
   is itself set via `DATA_DIR=` in either keys file (same priority as item 1 above); the owner changes it
   from a field in Cài đặt, which needs an app restart to take effect (it is resolved once at startup,
   before `state.json` can even be located).
3. **Workflow going forward**: commits push straight to `main`, no PR — only after the mock-API test suite
   (`checks_v2.py` + `e2e_v2.py`) passes on a fresh run. Each push adds one Vietnamese line to
   `CHANGELOG.md` describing what changed.

## 18. Addendum #6 (2026-09-29) — self-update from GitHub, owner just presses F5

1. A "Tự cập nhật code từ GitHub" block in Cài đặt: a read-only GitHub token field (only needed for a
   private repo) and a repo name field (default `<owner>/KTOONSTUDIO`), saved the same way and place as
   the API keys (§17 item 1) — `GITHUB_TOKEN`/`GITHUB_REPO` in the keys file, token shown only as
   `****<last 4>`, never logged or stored in `state.json`.
2. Every 2 minutes (`tap_thu_v2/updater.py`, a background thread started from `app.py`'s `main()`) the app
   calls `GET /repos/{repo}/commits/main`. A new commit sha triggers: download the zipball via `urllib`
   (`GET /repos/{repo}/zipball/{sha}`, no git needed), back up the current `app.py`/`pipeline.py`/
   `providers.py`/`updater.py`/`ui.html`, write the new ones over them — nothing else in `tap_thu_v2`,
   never `keys.txt`, never anything under `DATA_DIR` (§17 item 2). It then spawns a brand-new process on
   the next port and health-checks it for up to 20s. The **old process keeps serving throughout** — it
   never closes its own socket until the new one has already proven itself healthy, so a bad zipball can
   never take down a working app. A job mid-submission (`status == "running"` with no `pid` yet — the
   same narrow window app.py's own restart-resume logic already treats specially) blocks a scheduled
   check from applying; the "Kiểm tra cập nhật ngay" button (item 5) can override that and apply anyway.
3. If the new process never answers within 20s: it's killed, the backed-up files are restored on disk,
   and the old process — never interrupted — keeps running exactly as before. The failure is recorded and
   surfaced on the page (item 4) as a warning banner naming the commit that failed and that the rollback
   already happened; nothing further is needed from the owner.
4. The header shows a small strip: "Phiên bản: `<7-char sha>` · `<committer time>`". Once a new process
   has taken over on the next port, the *old* process's page (still open in the owner's browser) shows
   "Đã có bản mới — đang chuyển sang…" and navigates to the new port after ~1.5s, unless the owner is mid-
   edit somewhere (the existing per-section `dirty` tracking), in which case it shows the new URL instead
   of auto-navigating over unsaved text. Once the old process actually exits, any tab still pointed at it
   gets a 403 on its next poll — reusing the app's existing "phiên cũ hết hiệu lực, tải lại trang" handling
   — which now also auto-reloads after 2s when nothing is unsaved.
5. A "Kiểm tra cập nhật ngay" button (`/api/update/check_now`) runs the same check immediately in the
   background rather than waiting for the next 2-minute tick.

Tested against a fake GitHub API added to `ktoon_tap_thu/tests_mock/mock_providers.py`
(`/github/repos/.../commits/main`, `/github/repos/.../zipball/...`, plus a `/github/_control` endpoint the
test script uses to switch the mock between a good update, a broken one, and "nothing new"), in
`ktoon_tap_thu/tests_mock/update_check.py` — covers the full apply-and-handoff path, the broken-update
rollback path (verifying the serving process is never interrupted and no orphaned broken process is left
listening), and that project data survives a real handoff between two live processes. Still never a real
paid API call.

## 19. Addendum #7 (2026-09-29) — knowledge library (thay cho việc dán prompt mẫu từng lần)

1. A "Thư viện kiến thức" section: upload a file (`.docx`/`.md`/`.txt`/`.xlsx`, via the same stdlib
   `extract_text()` as §15 A.1) or paste text, tagged with one of 8 types: `shotlist_kich_ban`,
   `anh_nhan_vat`, `char_sheet`, `boi_canh`, `prop`, `storyboard`, `video_prompt`, `style`. One type can
   hold several independent documents. Stored under `DATA_DIR/kien_thuc` conceptually (in practice inside
   `state.json`'s `knowledge.docs`, since these are plain text, not media files) — each document keeps its
   full version history (`versions: [{v, text, word_count, created, condensed_text, condensed_approved}]`)
   with a movable `current_v` pointer; the owner can jump back to (or forward to) any past version without
   losing the others.
2. Every relevant step auto-injects the matching type's currently-active documents into that LLM call's
   system prompt: splitting a script into episodes uses `shotlist_kich_ban`; portrait/sheet/environment/
   prop/storyboard image prompts use their own matching type (`anh_nhan_vat`/`char_sheet`/`boi_canh`/
   `prop`/`storyboard`) plus `style`; writing a batch's video prompt uses `video_prompt` plus `style`.
   (Deterministic batch-splitting itself stays free/no-LLM, per §15 B.8 — unaffected.) The LLM is told to
   match the given document's exact structure and voice. Priority order: the owner's saved "Prompt mẫu"
   field (§15 A.3) first if set, then the knowledge library's current versions, then a flat fallback field
   (`style` only) — never both a template and the library for the same slot.
3. A document whose current version exceeds ~3000 words gets a "Rút gọn thành bộ luật" button (uses the
   misc LLM, §16 item 3) that produces a condensed rule set attached to that same version
   (`condensed_text`); the owner reviews/edits it in a textarea and only an explicit "Đã duyệt" checkbox
   (`condensed_approved`) makes it the text actually sent — before approval (and always for the raw
   original itself), nothing is altered. Each doc card shows its current version's word count and an
   estimated token count per call (`len(text)/3.5`, matching the app's own cost-estimate convention).
4. Every job that used a knowledge-library document (or a template, or a specific choice of neither)
   records exactly which document id(s) + version(s) — or `{"template": key}` — went into its prompt, in
   the job's own `knowledge_used` field, so the owner can tell which document to fix if a result is off.

New API routes: `/api/knowledge/upload_file` (raw body, `id` to add a version to an existing doc or
`type`+`name` to create a new one), `/api/knowledge/paste` (same, JSON), `/api/knowledge/set_version`,
`/api/knowledge/remove`, `/api/knowledge/condensed` (save an edit and/or set approval).

Tested purely against the mock (`ktoon_tap_thu/tests_mock/knowledge_check.py`): versioning and rollback,
that a knowledge doc feeds a real job's prompt when no template is set and that a template still wins once
one is set, that a long document is flagged and condensing measurably shrinks the injected text (checked
by comparing a `prompt` stage's dry-run price estimate before/after approval), and that removal works.
`checks_v2.py`/`e2e_v2.py`/`update_check.py` all still pass unchanged.

## 20. Addendum #7 bản chốt (2026-09-29) — slot-based knowledge library + task_form auto-fill (supersedes §19)

The owner's final word on the knowledge library (yêu cầu #7, "bản chốt"). Where this section conflicts
with §19's type-tagged design, §20 wins; §19's data shape (`STATE["knowledge"]["docs"][kid]["type"]`,
`KNOWLEDGE_TYPES`, `knowledge_context()`) is removed and replaced outright, not kept alongside it.

Project used to size the two sample fixture documents in the test suite: "The Alpha's Human Bride" (60
episodes).

1. **Storage scope.** Knowledge is per-project by default: `KTOON_DATA/projects/<dự án>/kien_thuc/<doc
   id>/vN.txt` (mirrored to disk for the owner to see; `state.json` stays the source of truth, same as
   every other piece of app state). The one exception the owner named — the Shotlist Instruction document
   — is shared knowledge, not tied to one project: any doc whose approved sections resolve ONLY into the
   `shotlist_rules` slot (see item 1 below) is stored under `KTOON_DATA/kien_thuc_chung/<doc id>/vN.txt`
   instead, and its content is available to every project. `pipeline.py`: `GLOBAL_SLOTS = {"shotlist_rules"}`,
   `_infer_scope(sections)`, `knowledge_global_dir()`/`knowledge_project_dir()`/`_doc_dir(doc)`.
2. **Upload with no type tag — the "Thủ thư" (librarian).** `/api/knowledge/upload_file` and
   `/api/knowledge/paste` take only a file/text and an optional `name`; the owner never picks a type.
   `librarian_run(kid)`:
   - Structural split first, free: `_split_by_headers(text)` looks for `#`/`##`/`§ N`/`Section N`/
     `Master 0N` header lines and cuts the document there. A document with fewer than 2 such lines (no
     real structure) falls through to one misc-LLM call (`KB_SPLIT_SYS`, job kind `kb_split` folded into
     the same `kb_librarian` job) that returns `{"sections": [{"title","text"}, ...]}`, told to keep every
     word somewhere and never summarize.
   - Slot classification: a keyword table (`_SLOT_KEYWORDS`) matches a section's title against the
     patterns the owner's own examples imply (`"Master 0N"` → the matching image/video slot, `"§2"`/
     `"§3"`/`"project instruction"` → `project_system`, `"§4"`/`"reusable task input"` → `task_form`,
     `"§12"`/`"qc checklist"` → `qc_checklist`, `"continue clip"`/`"repair image"`/`"review result"` for
     §11's sub-parts, `"master instruction"`/`"cinematic literary shotlist workflow"` → `shotlist_rules`).
     Only a section the keyword table cannot place at all gets escalated to one misc-LLM call
     (`KB_CLASSIFY_SYS`) — batched as a single call covering every ambiguous section in the doc, never one
     call per section (hard rule #8: batch LLM reasoning into few calls). Any LLM calls `librarian_run`
     makes are logged as a real `kb_librarian` job/ledger entry with their measured cost, and are skipped
     (with the section left for the owner to file by hand) once `spent + reserved` is within $0.05 of the
     budget cap — a knowledge upload can never silently blow through the cap (hard rule #1).
   - The result is a table, one row per section: title + a preview, the slot(s) assigned (a multi-select,
     editable), and an "approved" checkbox (`set_section_slots`, `/api/knowledge/set_section`) — the owner
     edits/approves it, exactly as asked. One section can be filed under several slots (used for `§2`+`§3`
     both landing in `project_system`).
   - Re-uploading a file/paste under the SAME name (case-insensitive) is a new version of that doc, not a
     duplicate (`upload_knowledge`); the librarian re-runs and each section carries a `changed` flag versus
     the previous version's same-titled section, so the UI can highlight just what changed. Versions and
     rollback (`set_knowledge_version`) work exactly as in §19.
   - A slot claimed by an approved section in more than one different doc is a conflict
     (`slot_conflict(slot_key)`, surfaced as `knowledge_conflicts` in `/api/state`) — the app still combines
     all of them by default (never blocks), and the owner resolves it by unchecking "approved" on the one
     that should stop counting, using the very same table.
3. **The slots** (`SLOTS`/`SLOT_NAME` in `pipeline.py`), replacing §19's 8 types: `shotlist_rules`,
   `project_system`, `task_form`, `img_char_single`, `img_char_sheet`, `img_location`, `img_prop`,
   `video_writer`, `video_example`, `continue_clip`, `repair_image`, `review_result`, `qc_checklist`.
   `project_system` is prepended to the system prompt of every LLM step that writes a prompt or reviews/
   critiques one (image-prompt writing via `template_prompt()`, video-prompt writing, `review`, `critique`)
   — not just the step whose own dedicated slot it is. `resolve_prompt_source(template_key, slot_key)`
   keeps §15 A.3's priority: the owner's saved "Prompt mẫu" template wins if set, the knowledge library's
   slot text otherwise. A document under ~6000 words (`CONDENSE_WORD_THRESHOLD`, raised from §19's 3000) is
   always sent whole; longer ones get the same condense-and-approve gate as §19 item 3.
4. **Script → shot list → sequence-based batch → video-prompt task_form (the two-tier flow).**
   - `shotlist_from_script` (new stage, target = one episode id): system = the `shotlist_rules` slot's
     text (falls back to a built-in `SHOTLIST_FROM_SCRIPT_SYS` only when that slot is still empty); user =
     the episode's own `script_raw` (`/api/episode/script`). Output is a Vietnamese shot list, English
     dialogue kept as-is, in the exact format the owner specified: `# SEQUENCE n: <title>` blocks, each
     holding `## SHOT NN` entries with Duration/Framing/Camera/Thoại/Character/SFX/Mood, ending with
     SOURCE/CONTINUITY NOTE lines. Skippable: if the owner already has a shot list for the episode, paste
     it straight into `/api/episode/shotlist` and this LLM step is never called.
   - `parse_shotlist_md(text)` reads that exact markdown (`# SEQUENCE`/`## SHOT`/field lines) with regexes,
     no LLM; a shot missing `Duration` gets one estimated from its own dialogue (`dialogue_fits`'s formula,
     below), never left blank. `apply_shotlist_md()` turns the parse into the episode's existing `shots`
     JSON list (so every other screen — QC, export, storyboard — keeps working unchanged) plus a NEW
     sequence-aware batch splitter, `split_batches_by_sequence()`: shots are grouped in order, a group ends
     when the `# SEQUENCE` changes or adding the next shot would push it over 30s — it never crosses a
     sequence boundary and, because a shot is always kept whole, it never splits a beat's own dialogue
     either. `/api/episode/batches/split` picks this splitter automatically whenever the episode has a
     `shotlist_md`, and falls back to §15 B.8's location-based `split_batches()` otherwise.
   - Writing each batch's video prompt (`run_llm`'s `prompt` kind) assembles system = `project_system` +
     `video_writer` (owner template `video_structure` still wins if set) + `continue_clip` (only for a
     batch that follows another one) + `video_example`, and asks the LLM to always end with the verbatim
     Prohibited line. The user message is `task_form` (owner template, else the slot, else a built-in
     fallback with the same field names) with every `{{FIELD}}` filled in by the app itself
     (`_fill_task_form()`/`_fill_task_form_text()`) — `DELIVERABLE=VIDEO`, `EPISODE_AND_SHOTS`,
     `APPROVED_SOURCE_EXCERPT` (the batch's own shot lines, verbatim), `REFERENCE_MAP` (from
     `build_mapping()`, item 5 below), `START_STATE` (the previous batch's own "END STATE" line if it wrote
     one, else its prompt's tail), `OUTPUT_SETTINGS` (9:16 + the batch's duration), `OUTPUT_MODE=
     READY_PROMPT_ONLY`, `TOOL_LIMITS` (the batch's chosen model's known caps). The owner never sees or
     fills a `{{...}}` themselves; if the app truly cannot compute a field the task_form document asks for,
     the job fails with a clear "app không tự điền được, cần bạn bổ sung" error naming the field, rather
     than guessing. A batch that continues another one and whose predecessor has no finished video yet
     fails the same clear way, naming the predecessor, instead of silently omitting `START_STATE`.
5. **Reference images sent to Seedance (`build_mapping()`).** Every character in a batch now gets BOTH
   an approved single portrait (labeled "face lock … identity/face reference only") and an approved
   character sheet (labeled "turnaround sheet … NEVER a starting frame") by default — never the sheet
   alone. Each batch has a `ref_mode` (`"single"|"sheet"|"both"`, default `"both"`), settable per batch via
   `/api/batch/ref_mode` for the owner to compare; `REFERENCE_MAP` always states each reference's exact
   scope so the LLM (and the owner reading the prompt) knows the sheet is for costume/angles only.
6. **Char sheet background — owner override.** The owner's decision (solid white, not Master 02's warm-
   grey) is passed to the LLM as an explicit, unmissable override on top of whatever the `img_char_sheet`
   slot document says (`template_prompt(..., override=...)`), not just left to hope the model reads the
   template correctly.
7. **Dialogue-duration check.** `dialogue_fits(dialogue, seconds)` = `len(dialogue.split()) / 2.3 +
   1.0`s (`DIALOGUE_WPS`/`DIALOGUE_BUFFER_S`) compared against the shot/batch's own duration;
   `batch_dialogue_warnings()` surfaces a `⚠` on the `prompt` stage's dry-run label when a shot's dialogue
   would need more time than it has. A check only — nothing is ever auto-cut.
8. **Provenance.** Every job that used a knowledge-library slot records `{"slot": key, "id": doc_id, "name":
   doc_name, "v": version}` per slot it drew from, in the same `knowledge_used` field §19 introduced — now
   keyed by slot instead of type, and covering every step listed in item 3, not just image/video-prompt
   writing.

New/changed API routes over §19: `/api/knowledge/upload_file` and `/api/knowledge/paste` drop `type`;
`/api/knowledge/set_section` (edit/approve a section's slots); `/api/episode/script` and
`/api/episode/shotlist` (paste a script or a ready-made shot list for one episode); `/api/batch/ref_mode`.

Tested purely against the mock, with two sample documents shaped like the owner's real ones — a
shotlist-workflow doc with no header structure (forces the LLM split + LLM classify fallback) and a
project doc with `§2`/`§3`/`§4`/`Master 01-06`/`§11` sub-parts/`§12` headers (pure heuristic, zero LLM
cost) — in `ktoon_tap_thu/tests_mock/knowledge_check.py` (55 checks, rewritten in place — supersedes the
§19-era version of this file): no-type upload and auto-slotting, scope inference (global vs. project),
diff-on-reupload + rollback, a slot conflict between two docs and resolving it by hand, condense-and-
approve's price delta, on-disk storage location for both scopes, the shot-list→sequence-batch pipeline
including the missing-Duration estimate and the dialogue-duration warning, the dual-reference `ref_mode`
toggle, the char-sheet white-background override actually reaching the model, task_form auto-fill, and the
continuation guard's clear failure message. `checks_v2.py`/`e2e_v2.py`/`update_check.py` all still pass
unchanged on a fresh instance.
