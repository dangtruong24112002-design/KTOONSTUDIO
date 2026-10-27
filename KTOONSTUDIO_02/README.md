# KTOONSTUDIO_02 — active app snapshot

Synced from the local app folder on 2026-10-28.

- Backend version/build: **4.2.13 / 2026-10-26**
- UI version/build: **4.2.53 / 2026-10-23**
- Windows start: run `CHAY_KTOONSTUDIO.bat` or `py -3 app.py` (Python 3.8+, standard library).

This folder contains the app source, Story Studio source modules, launcher files, and the bundled browser assets under `data/vendor/`.

## Local data and secrets

The running app stores API keys, projects, chats, jobs, uploads, media, references, logs, and other private state locally. Those files are intentionally not part of this source snapshot. Keep `keys.txt`, `.env` files, `data/` runtime content, and `LIBRARY/` out of Git. The `.gitignore` in this folder keeps runtime data ignored while allowing only the shipped `data/vendor/` assets.

## Skills

The app includes its Skill Library UI and app-wide skill matching in `ui.html` and `story_studio/ss12_skills.js`. The video-editing skill source and its license are included in `skills/video-editing/`. The app stores installed skill documents in its own server-side Skill Library; storing the source package here does not seed a separate app instance's private library. Import the included `SKILL.md` through the Skill Library when setting up another instance.
