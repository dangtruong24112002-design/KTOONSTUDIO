# KTOONSTUDIO — Product & Engineering Brief (v1, 2026-09-27)

## 1. Goal and context
Owner: Truong, KToonStudio. Vietnamese studio, already produces AI video by hand using
Dreamina / Seedance 2.5. He is not a programmer.

Long-term product: an "AI studio in a box" that any company or creator can own — the whole
org chart of a content studio as software, plus a learning brain on top.
Right now we build the internal version and use it ourselves. Selling comes later; the
architecture must not block multi-tenant later, but v1 is single-user.

First product: a vertical (9:16) short-drama series.
- Look: PHOTOREAL (AI-generated humans, not anime).
- Dialogue: ENGLISH. Audience: US / global. Story formula follows the US microdrama market
  (hidden billionaire, revenge, secret identity, contract marriage, alpha/werewolf, rags-to-riches).
- Episode: 60-90 s, hook inside the first 3 seconds, cliffhanger at the end of every episode.
- Series: 60 episodes eventually. v1 target is ONE pilot episode, fully automatic, with
  measured cost and time per episode.
- Distribution v1: TikTok / YouTube / Facebook (owner's channels). Burned-in English subtitles;
  a second Vietnamese-subtitle export is a cheap optional extra.

Why not just use ByteDance's own tools: Xiaoyunque Short Drama Agent (Mar 2026) and Dramagic
(Sep 2026) already do script-to-screen at ~¥500-1000/episode. Our edge is not "automation
exists" — it is cost control, model independence, owned virtual cast, and later a learning
brain that raises hit rate. In China only ~0.47% of AI short dramas pass 100M views: the
bottleneck has moved from production to hit-making.

## 2. Hard constraints
- Runs on the owner's Windows 11 PC, NVIDIA GPU 8-12 GB. No server.
- API budget < $190/month (5 million VND). Money is constraint #1 in every design choice.
- Accounts: WaveSpeedAI (active, primary for images and video), BytePlus ModelArk (later, cheaper
  finals), LLM API keys for Claude and/or GPT (not created yet, see 8.1), paid Dreamina (manual use only).
- Automation with 4 human approval gates, each switchable.
- Owner reviews in a local web dashboard, in Vietnamese.

## 3. Architecture
Single local app. SQLite is the only source of truth. A worker drains a job queue; the web
dashboard is a view over the same DB. Every long step is a job row with status, so the app can
be closed and reopened at any time.

Provider adapters are mandatory. Every external model call goes through a narrow interface:
  VideoAdapter.generate(shot_spec) -> Take
  ImageAdapter.generate(image_spec) -> Image
  LlmAdapter.complete(prompt, schema) -> dict
  LlmAdapter.chat(messages, tools, stream=True) -> events   (project assistant, see 8.1)
  TtsAdapter / LipsyncAdapter / UpscaleAdapter
Adding a model = adding one file + a row in config/models.yaml. Business code never names a
provider. Reason: OpenAI shut the Sora API on 2026-09-24; any system welded to one vendor dies
with it.

## 4. Data model (build this first)
SQLite tables:
- project(id, name, style_bible, rules_json)
- character(id, code "NV.A", name, canon_description, lock_images[], prompt_block, rules, status, version)
- location(id, code "BC.1", canon_description, lock_images[], prompt_block, status, version)
- prop(id, code "P.1", canon_description, lock_images[], status)
- episode(id, number, logline, summary, script, hook, cliffhanger, status)
- shot(id "EP01_S03", episode_id, order, action, camera, dialogue_en, duration_s,
       character_ids[], location_id, prop_ids[], keyframe_image_id, prompt_text,
       negative_prompt, status, chosen_take_id, cost_total)
- take(id, shot_id, model, params_json, file_path, qc_scores_json, verdict, reject_reason_enum,
       cost_usd, latency_s)
- image(id, kind, owner_ref, file_path, prompt, scores_json, status)
- generation_log(id, ts, kind, model, request_json, response_json, cost_usd, ok, error)
- budget(scope, limit_usd, spent_usd), approval(gate, target_id, status, note, ts)

One record per character/location/prop, reused across all 60 episodes. Editing a location edits
one row; every shot referencing it follows. reject_reason_enum is a closed list — it is the
training data for the future brain.

Project files on disk: data/projects/<name>/
  00_kho/ (lock images + canon descriptions) · 01_kich_ban/ · 02_shotlist/ ·
  03_workspace/EpNN/ (keyframes, prompts, drafts, finals) · 04_thanh_pham/ · 05_so_sach/

## 5. Pipeline — four roles, four gates
Taken from the owner's handwritten brief; role numbering is his.

### Role 1 — Development
Input: brief / idea script / outline / long web-novel / reference video.
1. Analyse input (a reference video is read by a multimodal LLM for pacing, genre, style).
2. Series outline -> arcs -> how many episodes per arc.
3. Episode list + per-episode summary.
4. Self-review pass: logic, pull, consistency with the bible. Concrete defects only, max 2 repair loops.
5. Episode script + English dialogue (short lines; vertical drama dialogue is 1-2 sentences).
6. Detailed shot list as JSON matching the `shot` schema.
7. Extract the character / location / prop list per episode into the registry.
=> GATE 1: bible + episode list + pilot shot list.

### Role 2 — Visual pre-production
1. Write pre-production prompts for each character (multi-angle, multi-expression sheet),
   location, prop.
2. Generate with Seedream.
3. Machine selection: a vision LLM scores each image against the canon description and rejects
   hand/face/proportion defects.
4. Repair pass (edit / inpaint) where needed.
5. Lock into the registry: 8-12 lock images per character, 2-4 per location.
6. Link images to asset codes and to every shot that uses them.
=> GATE 2: cast + locations approved.

### Role 3 — Production
1. STOCK CHECK. An episode may only enter production when script, shot list and every
   referenced asset are approved. Otherwise block and send back. This is the main money gate.
2. Build the per-episode workspace: lock images, prompt blocks and references staged per shot.
3. Generate a KEYFRAME image per shot (Seedream) and approve at image level.
4. Generate video image-to-video from the approved keyframe. Never text-to-video for story shots.
5. Two modes: batch (4 parallel shots) and sequence (continuity, uses extend).
6. QC every take; failures re-generate up to 3 times, then stop and ask.

### Role 4 — Post and delivery
Assemble by shot list -> audio (see 6.3) -> burned-in English subtitles inside the 9:16 safe
area -> upscale to 1080x1920 -> AI label + metadata -> package (cover, title, description,
hashtags). => GATE 3 (cut) and GATE 4 (release package).

### Orchestration
Executive producer (project state, what is next, talks to the owner) and line producer
(per-episode and monthly budget caps, blocks at the cap, keeps the ledger).

## 6. Cost model and routing (verified 2026-09-27 on the live provider pages)

### 6.1 Providers
PRIMARY (set up first): **WaveSpeedAI** — one API key, all the models the pipeline needs, free
credits on signup, no credit card required.
REST shape: `POST https://api.wavespeed.ai/api/v3/<model-path>` returns a prediction id; poll the
result endpoint about every 2 s, back off for long tasks, stop on a terminal status, read
`data.outputs`.

| Job | Model path | Price |
|---|---|---|
| Final video | `bytedance/seedance-2.5/image-to-video` | 480p $0.18/s ($0.90 per 5 s) · 720p $0.36/s ($1.80) · 1080p $0.90/s ($4.50) · 4k $1.80/s |
| Text-to-video (rare) | `bytedance/seedance-2.5/text-to-video` | same tiers |
| Continuity | `bytedance/seedance-2.5/video-extend` | per second |
| Character / location / keyframe images | `bytedance/seedream-v5.0-flash` · `seedream-v5.0-pro` | $0.027 · $0.045 per image (edit variants same, up to 10 refs) |
| Motion drafts | `wavespeed-ai/minimax-h3/image-to-video` | $0.10 per run (480p-768p, 5-15 s, native audio) |
| Second opinion | `alibaba/wan-3.0/image-to-video` | $0.475 per run |
| Audio fallback | `bytedance/seed-speech-tts-2.0`, `bytedance/latentsync`, `bytedance/lipsync/audio-to-video`, `bytedance/seedance-2.5/talking-avatar` ($1.10) | cheap |
| Upscale / repair | WaveSpeed upscalers, `wavespeed-ai/face-enhancer/video` | cheap |

Seedance 2.5 i2v parameters: `prompt`, `image` (required), `last_image`, `duration` 4-30 s
(default 5), `resolution` 480p/720p/1080p/4k (default 720p), `generate_audio` (default true).
Output aspect ratio follows the input image — so the keyframe must already be 9:16.

SECONDARY (add when an international card is available): **BytePlus ModelArk direct** —
Seedance 2.5 at 480p $0.1028/s and 720p $0.2312/s, about 35% cheaper than WaveSpeed for final
shots, plus the private virtual-portrait library for stronger identity locking. Selected per job
in `config/models.yaml`; no business code changes.

### 6.2 Rules that follow from these prices
- A Seedream image costs 1/40 to 1/65 of one 5-second 720p Seedance take. Approve at image level.
- A MiniMax H3 draft ($0.10) is ~18x cheaper than a 720p Seedance take. Draft the motion first,
  pay for the final once.
- Image-to-video only for story shots; never text-to-video without an approved keyframe.
- 5-8 second clips. Final at 720p, upscale locally to 1080x1920. Never generate 1080p or 4k
  directly for story shots.
- Lock each character and location once; reuse across all 60 episodes.

### 6.3 Expected cost of one 90-second episode (18 shots x 5 s)
| Stage | Model | Unit | Qty | Cost |
|---|---|---|---|---|
| Keyframes | Seedream Flash | $0.027 | ~25 incl. rejects | $0.68 |
| Motion drafts | MiniMax H3 | $0.10 | 18-25 | $1.80-2.50 |
| Finals, first take | Seedance 2.5 720p (WaveSpeed) | $1.80 | 18 | $32.4 |
| Finals, 1.8x retakes | same | $1.80 | ~32 | $58 |
| Finals on ModelArk instead | Seedance 2.5 720p | $1.156 | 18 / 32 | $20.8 / $37 |

Pilot on WaveSpeed alone: roughly **$35-60 per episode**. With ModelArk for finals: **$23-40**.
At $190/month that is 3-5 episodes, or 5-8 with the ModelArk route. The retake multiplier is the
only unknown — M0 measures it, then this table gets rewritten with real numbers.

### 6.4 Audio — English dialogue
Default: let Seedance speak natively (`generate_audio: true`). English is the strongest language
for these models and the lip sync comes with the shot.
Per-shot fallback: generate silent (`generate_audio: false`), then `seed-speech-tts-2.0` plus
`latentsync` or `talking-avatar`. Use it for dialogue-heavy close-ups and whenever a line must
change without paying for a new video generation.
Always include "no subtitles" in the prompt — subtitles are burned in during post, never by the
model.

## 7. QC — three layers per take
L1 machine metrics (ffmpeg/opencv): resolution, black frames, freeze, loudness LUFS, duration.
L2 vision model: matches shot description, right location, character similarity against lock
images (face embedding score), hand/object defects, wardrobe and prop continuity.
L3 human, at the four gates only.
Every rejection writes a structured reason. Owner notes at a gate must be fed back into the
next prompt for that shot.

## 8. Workspace UI
A canvas workspace, not a dashboard. Full spec: `docs/UI_BRIEF.md`. Reference implementation of
all interactions (zoom, pan, select, move, marquee, drag-to-assign, approve/send-back, semantic
zoom): `docs/ui/ktoonstudio_prototype.html` — vanilla JS, so it fits the no-npm stack; port it,
then wire it to the SQLite state and the job queue.

### 8.1 Project assistant — "Trợ lý AI" (added 2026-09-27, milestone M1.5)
Owner's request: connect GPT, Claude and similar models as a project assistant with a chat panel, and
work from that panel. Reference implementation of the UI and of the permission model:
`docs/ui/ktoonstudio_prototype.html` (section "AI assistant"). The prototype runs on Claude through the
claude.ai artifact runtime; the real tool calls the provider APIs below.

**What it is.** A chat in the right-hand panel (tab "Trợ lý") that knows the open project — episodes,
shots, registry, prompt rules, spend, running jobs — and what the owner has selected on the canvas. It
answers questions, writes and fixes Seedance prompts, checks continuity, estimates cost, and acts on the
project through tools.

**Permission tiers — the core rule, enforced by the server, not by the prompt.**

| Tier | Tools | What happens |
|---|---|---|
| READ | get_state, get_shot, read_script, search_project, get_spend, list_jobs | Runs automatically. |
| EDIT | update_shot (action, dialogue_en, camera, prompt_text, negative_prompt, duration_s, characters, location), add_shot, move_shot, write_note | Runs automatically, versioned in `assistant_action`, one-click undo in the chat. |
| PROPOSE | generate (keyframe / draft / final video), approve, send_back, delete_*, change_character_canon, change_location_block, change_budget_caps | Creates a `proposal` row and a card in the chat: what, which shots, cost, episode spend before -> after. Nothing runs until the owner clicks "Đồng ý". The accept endpoint re-checks caps and eligibility at click time. The model has no route that executes a proposal. |

Anything that costs image or video money, or passes a gate, is PROPOSE — always. Canon changes (a
character's look or rules, a location block) are PROPOSE too, because they change every episode.

**Providers and models.** New adapters in `studio/adapters/llm/`:
- `anthropic.py` — Claude Messages API: streaming, tool use, prompt caching on the system block.
- `openai_compat.py` — one adapter for every OpenAI-compatible endpoint: OpenAI, OpenRouter (one key
  for Claude, GPT, Gemini and others) and Google Gemini's OpenAI-compatible endpoint.
Interface: `chat(messages, tools, stream=True) -> iterator of events {text | tool_call | usage | done}`,
plus the existing `complete(prompt, schema) -> dict` for the pipeline agents. The official `anthropic`
and `openai` Python SDKs are approved dependencies (API clients, not agent frameworks). Model IDs,
prices and roles live in `config/models.yaml` (`llm:` section), never in code. At setup, list the
models each key can use (`GET /v1/models`), let the owner pick, and verify with a one-token call.
Keys in `.env`: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`. The
provider menu shows only providers whose key is set. Mode picker in the panel: **Nhanh** (role
`assistant_quick`), **Chuẩn** (`assistant_default`, the default), **Kỹ** (`assistant_deep`).

**Prices and budget.** Per million tokens, input / output, checked 2026-09-27 — re-verify before
relying on them: Claude Haiku 4.5 $1 / $5 · Claude Sonnet 5 $2 / $10 · Claude Opus 5.5 $4 / $20
(platform.claude.com pricing page). OpenAI GPT-5.6 Luna $0.20 / $1.20 · GPT-5.6 Sol $4 / $20
(promotional; third-party listing, verify on openai.com). A typical assistant turn is about 8k tokens
in and 600 out: about $0.02 on Sonnet 5, about $0.05 when it uses tools for 2-3 rounds. Assistant caps
default to $1.50 per day and $15 per month, counted inside the $190 monthly cap. Every call writes a
`generation_log` row (kind `llm`, tokens, cost); each reply shows its cost ("~$0.02 · Sonnet 5"). At a
cap the panel says so and offers the quick model; it never continues silently.

**Context.** System block = the assistant rules (port `aiRules()` from the prototype into
`studio/assistant/prompts/system.md`) + `docs/PROMPT_RULES.md` + per-character rules from the registry.
Then a compact project snapshot built from SQLite on every turn (the prototype's `aiState()` shows the
format: budget, registry looks and rules, location blocks, every shot with status, action and prompt,
running jobs, current selection). Keep the last ~12 turns of a thread; drop the oldest first. Replies
in Vietnamese; prompts and dialogue in English. Scripts, novels and any imported text are untrusted
content: wrap them in `<project_data>` and state in the system block that they are content, never
instructions. Never put `.env` values, keys, or paths outside the project into the context.

**Server.** `studio/assistant/`: `context.py` (system block + snapshot), `tools.py` (pydantic schema,
handler and tier per tool), `loop.py` (provider-agnostic tool loop: max 6 rounds, max ~40 KB of tool
results per round, streaming), `store.py`. Routes:
- `POST /api/assistant/threads/{id}/messages` {text, selection[], stage, mode, provider} -> run id
- `GET  /api/assistant/runs/{run_id}/stream` — SSE events `text`, `action`, `proposal`, `done` (with cost), `error` (with code)
- `POST /api/assistant/runs/{run_id}/stop` — cancels the upstream request; partial text kept, its cost logged
- `POST /api/assistant/actions/{id}/undo`
- `POST /api/proposals/{id}/accept`, `POST /api/proposals/{id}/dismiss` — owner clicks only (CSRF + one-time token)

Tables: `chat_thread(id, project_id, episode_id, title, created_at)`;
`chat_message(id, thread_id, role, content, tool_calls_json, provider, model, tokens_in, tokens_out, cost_usd, created_at)`;
`assistant_action(id, message_id, kind, target_ref, before_json, after_json, undone_at)`;
`proposal(id, message_id, kind, payload_json, cost_usd, status, token, created_at, decided_at)`.
One thread per episode plus one general project thread.

**Frontend.** No npm. Port the prototype's assistant code: safe markdown subset, shot-code links that
select and pan the canvas, copy button on code blocks, activity rows with undo, proposal cards, Stop,
mode picker, IME-safe Enter. Replace the prototype's `sample()` call with `fetch` + `EventSource`. The
panel must work on the current dashboard before the canvas is ported.

**Done when (M1.5 acceptance).**
1. No key in `.env`: the panel says which key is missing and points to HUONG-DAN.md; the rest of the app works.
2. "Còn bao nhiêu tiền để làm xong Tập 01?" returns numbers that match the ledger.
3. "Viết prompt Seedance cho EP01_S05" saves `shot.prompt_text` following PROMPT_RULES.md and shows an activity row; Undo restores the old value.
4. "Tạo video cho S05" only produces a card; no video `generation_log` row until "Đồng ý"; accepting re-checks the $40 cap.
5. Stop mid-answer cancels the upstream call; the partial answer stays; its cost is logged.
6. Tests: a model that calls a PROPOSE tool can never spend (unit test on the loop); cost math per provider; context stays under the model's limit.

## 9. Milestones
M0. API smoke test — see docs/M0_SMOKE_TEST.md. Do this before writing anything else.
M1. DB + asset registry + script in -> shot list JSON out + Gate 1.
M1.5. LLM adapters (Claude + OpenAI-compatible) + the project assistant panel — see 8.1. This also
      wires the LLM step M1 needs for script analysis.
M2. Character/location image generation + machine selection + lock + Gate 2.
M3. Per-shot keyframe -> image-to-video -> QC -> take selection. Canary of 3 shots before batch.
M4. Audio + assembly + subtitles + upscale + export + Gate 3.
M5. Cost ledger, episode report, disk cleanup policy. Deliver one finished pilot episode.
Later (not v1): learning brain, auto marketing, channel analytics, multi-tenant, multi-series.

## 10. Conventions
- Keys from .env; never logged.
- Every API call: retry with backoff, timeout, and a generation_log row with real cost.
- Idempotent: a shot has one key; re-running never creates duplicate takes.
- config/models.yaml holds routing, prices, caps and fallback order.
- Storage policy: after an episode is approved, keep the chosen take plus one backup, archive
  the rest. A 60-episode series will otherwise fill the disk.
- Owner-facing strings in Vietnamese; code, comments and docs in English.

## 11. Decisions still open (resolve with data, not opinion)
- Real retake ratio per shot (M0/T2).
- Whether Seedance's native English dialogue is releasable for close-ups (M0/T3).
- Whether the ModelArk account exposes the private virtual-portrait library (asset://<id>);
  if it does, register the cast there for stronger identity locking.
- ModelArk concurrency/rate limits on this account — discover empirically in M0, then set the
  queue's parallelism.

## 12. Known risks and mitigations (researched 2026-09)
A. REAL FACES ARE BLOCKED. BytePlus/Volcengine do not accept reference images or videos
   containing real human faces; occlusion tricks (sunglasses, blur, crop) are detected. The
   documented paths are platform virtual avatars (asset://<id>), AI-generated fictional
   portraits (these pass the filter — different pixel statistics from camera photos), or
   enterprise-authorised real-person material. We use AI-generated portraits from Seedream.
   If one lock image is refused, auto-retry with an alternate lock image before asking a human.
B. LONG CLIPS AMPLIFY LOSS. Keep generations at 5-8 s; use extend for continuity.
C. 1080p COSTS 2.5x. Generate 720p, upscale locally.
D. 8-12 GB GPU CANNOT DRAFT VIDEO USEFULLY. GPU is for upscale, face scoring, lip sync,
   image work. Motion drafts go to 480p API or a cheap model.
E. BATCHING EVERYTHING AT ONCE IS DANGEROUS. One bad system prompt ruins a whole batch.
   Canary 3 shots -> 1 episode -> then batch, always under a cap.
F. UNKNOWN RETAKE RATIO drives the whole business case. Measure and log forever.
G. CHANNEL ANALYTICS FOR THE FUTURE BRAIN: YouTube Analytics API exposes retention curves;
   TikTok and Facebook are restricted to business accounts or manual CSV export. v1 connects
   nothing; it only keeps its own production metrics.
H. LEGAL. Vietnam AI Law 134/2025/QH15 (in force 2026-03-01) requires labelling of AI-generated
   content that simulates real people or real events, plus a machine-readable marker. Platforms
   (YouTube, TikTok, Meta) require AI disclosure for realistic content. Always write the label
   and embed metadata on export; never model a real person.
I. AGENT SPRAWL. An 8-department org chart with an LLM call per role per shot would cost more
   in tokens than in video. Agents exist only where judgement is required; merge same-context
   roles into one call returning JSON for the whole episode.
J. HOMOGENISATION. Every competitor uses the same models. The differentiators are the owned
   virtual cast, the owner's prompt frameworks (docs/PROMPT_RULES.md), and hit-rate learning.

## 13. Do not
- Do not hardcode or print API keys.
- Do not run a batch before its canary passed, or without a budget cap.
- Do not use photographs of real people.
- Do not automate the Dreamina web UI.
- Do not add a heavy agent framework.
- Do not delete the owner's files.
- Do not publish to any platform before Gate 4.
- Do not let an LLM run anything that spends money or passes a gate: it may only create a proposal
  that the owner clicks (8.1).
