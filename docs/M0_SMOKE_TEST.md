# M0 — API smoke test (do this before writing any application code)

Purpose: replace estimates with measured numbers. Section 6 of BRIEF.md depends on the real
retake ratio, real per-clip cost and latency on THIS account.

Provider for M0: **WaveSpeedAI**. Hard budget: **$5**. Stop the script at $5 spent.
New accounts get free signup credits — spend those first and report how far they go.

## Before you start
1. The owner puts his key in `.env` as `WAVESPEED_API_KEY` (copy `.env.example` to `.env`).
   Never ask him to paste a key into chat; tell him the file and the line.
2. Read the model page schema before coding: `POST https://api.wavespeed.ai/api/v3/<model-path>`
   returns a prediction id; poll the result endpoint about every 2 s; read `data.outputs`.
3. Write one throwaway script `scripts/m0_smoke.py`. Every call is appended to
   `data/m0_log.jsonl` with model, params, latency, billed cost, ok/fail and the output URL.
   Download every output into `data/m0/`.

## T1 — connection and true price (~$0.15)
`bytedance/seedream-v5.0-flash` — generate one 9:16 portrait of a fictional adult character,
US-looking, photoreal, for an English-language vertical drama. Then one more with a different
seed.
Measure: request/response shape, latency, real cost, whether 9:16 comes out correctly.
This also produces the lock image used by T2, so write the prompt with PROMPT_RULES.md section
"Real-person / character formula (7 dimensions)".

## T2 — character lock, the most important test (~$3)
1. From the T1 portrait, generate 3 keyframes in different angles and 2 locations with
   `seedream-v5.0-flash` edit (portrait as reference). Keep 9:16.
2. For each keyframe, generate a 5 s 720p clip with `bytedance/seedance-2.5/image-to-video`,
   `generate_audio: false`, prompt "no subtitles".
3. Score face similarity between the first/middle/last frame of each clip and the lock portrait
   (any face-embedding model; CPU is fine for three clips).
Measure: similarity per clip, how many regenerations were needed for an acceptable take, and
whether any request was refused for containing a real person (it must not — the portrait is
AI-generated).
Output: the real retake ratio. This number rewrites the whole cost model.

## T3 — English dialogue and lip sync (~$1.8)
One 720p 5-8 s clip from a keyframe, `generate_audio: true`, character delivers two short English
lines written into the prompt.
Measure: is the spoken English releasable, does the mouth match, does the model burn in unwanted
subtitles, is the voice stable.
Compare mentally against the fallback path (silent + `seed-speech-tts-2.0` + `latentsync`) but do
NOT spend money on the fallback yet unless T3 clearly fails.

## T4 — cheap draft path and concurrency (~$0.5)
Run 4, then 8 parallel `wavespeed-ai/minimax-h3/image-to-video` drafts ($0.10 each) from the T2
keyframes at the lowest resolution.
Measure: rejections, queue behaviour, error codes, wall-clock for the batch.
Output: safe queue concurrency, and whether MiniMax drafts are good enough to judge motion before
paying for a Seedance final.

## Deliverable — `docs/M0_RESULTS.md`
A table: | test | model | resolution | duration | attempts | accepted | cost | latency | notes |
plus four conclusions:
1. real cost per accepted second of finished footage;
2. real retake ratio per shot;
3. default audio path (native Seedance vs TTS + lipsync);
4. safe queue concurrency.
Then update BRIEF.md section 6.3 with the measured numbers, and tell the owner in Vietnamese what
one episode will actually cost and how many episodes his $190/month buys.
