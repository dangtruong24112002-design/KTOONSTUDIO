# KTOONSTUDIO_02 — active app snapshot

Synced from the local app folder on 2026-10-27.

- Backend 4.2.13; UI 4.2.53 (build 2026-10-23).
- Start on Windows with `CHAY_KTOONSTUDIO.bat` or `py -3 app.py` (Python 3.8+, standard library).
- Contains app/UI, Story Studio sources, launchers, and required browser assets under `data/vendor/`.

## Local data and secrets

API keys, projects, chats, jobs, uploads, media, references and logs remain local and are excluded. Keep `keys.txt`, `.env` files, runtime `data/`, and `LIBRARY/` out of Git. `.gitignore` preserves only the shipped `data/vendor/` assets.

## Skills

The app includes its Skill Library and app-wide skill matching. The video-editing skill source and license are in `skills/video-editing/`. Installed skill documents are stored in the app's server-side Skill Library; this source folder does not seed another instance's private library. Import `SKILL.md` in the Skill Library when setting up another instance.
