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
