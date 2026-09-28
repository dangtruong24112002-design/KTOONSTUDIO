# KTOONSTUDIO — operating contract for Claude Code

## Who you are working with
Project owner: Truong (KToonStudio). He is NOT a programmer.
- Always reply to him in Vietnamese, plain language, no jargon.
- Never tell him to "just run a command" without saying exactly where to type it.
- When something breaks: one sentence on what happened, then fix it yourself.
- Ask before anything that spends money or deletes files.

## What we are building
A local, single-user production system that turns a script into finished vertical (9:16)
short-drama episodes. Photoreal look, ENGLISH dialogue, US/global audience.
Full spec: `docs/BRIEF.md`. Prompt rules: `docs/PROMPT_RULES.md`. First task: `docs/M0_SMOKE_TEST.md`.

## Current provider (updated 2026-09-27)
The account that exists is **WaveSpeedAI**, not BytePlus ModelArk. Use `WAVESPEED_API_KEY` and
`POST https://api.wavespeed.ai/api/v3/<model-path>`. Model paths, prices and routing live in
`config/models.yaml`. Do not write `ARK_*` code paths until `providers.modelark.enabled` is true
in that file. Prices and the M0 plan in `docs/` were rewritten for WaveSpeed on 2026-09-27 —
re-read them if you loaded an earlier version.

## LLM and the project assistant (added 2026-09-27)
The owner wants a chat assistant ("Trợ lý AI") inside the tool, backed by Claude and/or GPT through their
APIs. Spec: `docs/BRIEF.md` 8.1 (milestone M1.5) and `docs/UI_BRIEF.md` (panel UX). Working reference:
`docs/ui/ktoonstudio_prototype.html`. Approved services for this: Anthropic API, OpenAI API, OpenRouter,
Google Gemini API. Approved dependencies: the `anthropic` and `openai` Python SDKs.
Iron rule: the model may read, and edit with undo; anything that spends money or passes a gate is only a
proposal the owner clicks. No LLM key exists yet — the app must run without one and the panel must say
which key is missing. The old `LLM_API_KEY / LLM_BASE_URL / LLM_MODEL` names are retired; `.env` may
still contain them (ignore them, never print `.env`).

## Hard rules — never break
1. MONEY. Every paid call is logged with its real cost and respects budget caps
   (default $40/episode, $190/month). Never start a batch before its canary passed.
2. NO REAL FACES. Never send a photograph of a real person as a reference image. All actors
   are AI-generated portraits (Seedream) stored in the asset registry. This is a provider
   restriction, not a preference: real-face inputs are rejected by Seedance.
3. IMAGE FIRST. Never spend video tokens on a shot with no approved keyframe image.
4. RESUMABLE. State lives in SQLite. Killing the process and restarting must never redo
   finished work or lose money already spent.
5. SECRETS. Keys come from `.env` only. Never print, log, or commit them.
6. NO SCRAPING. Never automate the Dreamina web UI.
7. NO HEAVY AGENT FRAMEWORKS. No LangChain / CrewAI / AutoGen. An "agent" here is a function
   that calls an LLM with a prompt and validates a JSON schema against `core/models.py`.
8. LLM SPEND IS BUDGETED TOO. Batch per-episode reasoning into few calls (target < $3/episode).
   Deterministic work (file IO, ffmpeg, API calls, scoring, bookkeeping) is plain code.
9. ASK FIRST before installing anything above ~2 GB, deleting anything outside the project,
   or calling a service not listed in `docs/BRIEF.md`.

## Stack — decided, do not change without asking
Python 3.11+ · FastAPI + Jinja2 + HTMX (no npm, no build step) · SQLite · httpx · pydantic ·
python-dotenv · ffmpeg (system) · Real-ESRGAN ncnn-vulkan (720p to 1080p) ·
faster-whisper (subtitle timing) · insightface + onnxruntime (face similarity; CPU fallback ok).
Target machine: Windows 11, NVIDIA GPU 8-12 GB. One command to run everything: `python -m studio`.

## Repo layout
```
studio/
  adapters/   video/ image/ llm/ tts/ lipsync/ upscale/   (one file per provider)
  core/       db.py models.py budget.py queue.py qc.py registry.py
  roles/      development.py preproduction.py production.py post.py
  web/        FastAPI app + templates
config/models.yaml    routing, prices, caps
docs/                 BRIEF.md  M0_SMOKE_TEST.md  PROMPT_RULES.md
data/                 studio.db, projects/<name>/{00_kho,01_kich_ban,02_shotlist,03_workspace,04_thanh_pham,05_so_sach}
```

## How to work
- Follow the milestones in `docs/BRIEF.md` section 9 in order. Do not skip ahead.
- After each milestone: run it, show the owner what it produced, wait for his OK.
- One CHANGELOG.md line per milestone.
- Tests only where they save money: cost math, JSON schema validation, queue resume.
- If a decision is missing from the docs, ask the owner in Vietnamese with 2-3 concrete options.

## Current priority (2026-09-28) — overrides older sections where they conflict
- Build `tap_thu_v2/` exactly as specified in `docs/SPEC_TAP_THU_V2.md` (one-episode test app: 30-second
  Seedance reference-to-video sequences, following the owner's hand-written workflow). `studio/` (M1) is paused: do not modify it.
- Providers for this task: video = Atlas Cloud (Seedance 2.5 / 2.0 reference-to-video); images + LLM = WaveSpeed
  (Nano Banana Pro, GPT-5.5, Gemini). Keys live only in `tap_thu_v2/keys.txt` (gitignored) — never print, log or commit them.
- Money for this task: $18/episode cap, max 2 full generations per sequence, then partial fixes only (spec section 4).
  This replaces the $40/episode default above.
- Hard rule 3 becomes REFERENCES FIRST: never spend video money on a sequence whose reference images and prompt are not approved.
- Hard rule 2 (no real faces) still applies: faces come from AI images only.
- These sessions run in the cloud on the owner's prepaid credit: work in small, testable steps; test with the mocks in
  `ktoon_tap_thu/tests_mock/`; never call real paid APIs from the cloud.
