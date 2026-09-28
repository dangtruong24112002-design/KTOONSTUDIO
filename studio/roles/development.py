"""Role 1 — Development: script in -> episodes + shot list + registry entries out.

Two engines share one output schema (core.models.ScriptAnalysis):
- "offline": free, deterministic rules. Understands common screenplay layouts:
    episode headers   EPISODE 1 / EP01 / Tập 1 / # Episode 1
    scene headings    INT. OFFICE - NIGHT / EXT. STREET / NỘI. / NGOẠI. / SCENE 3 / CẢNH 3
    dialogue          NAME: line   or   NAME (alone, upper case) followed by the line
    metadata          TITLE: / LOGLINE: / HOOK: / CLIFFHANGER: / SUMMARY: / TÓM TẮT:
  Everything else is action. It cannot invent camera language or split long actions well —
  that is the LLM engine's job, added when an LLM key exists (paid, budgeted).
- "llm": not wired yet (no LLM key in .env, and M1 must not spend money).
"""
from __future__ import annotations

import re
import sqlite3
from pathlib import Path

from studio import config
from studio.core import db, registry
from studio.core.models import CharacterIn, EpisodeIn, LocationIn, ScriptAnalysis, ShotIn

SCRIPT_EXTS = {".txt", ".md", ".docx", ".pdf"}

EPISODE_RE = re.compile(r"^\s*#*\s*(?:episode|ep\.?|tập|tap)\s*0*(\d{1,3})\b[\s:.\-–—]*(.*)$", re.I)
SCENE_RE = re.compile(
    r"^\s*#*\s*(?:(?P<slug>INT\./EXT\.|INT/EXT\.?|I/E\.?|INT\.?|EXT\.?|NỘI\.?|NGOẠI\.?)\s+(?P<place>.+)"
    r"|(?:scene|cảnh|canh)\s*\d+\s*[:.\-–—]?\s*(?P<place2>.*))$", re.I)
META_RE = re.compile(r"^\s*(title|tiêu đề|logline|hook|cliffhanger|summary|tóm tắt)\s*:\s*(.+)$", re.I)
INLINE_DIALOGUE_RE = re.compile(r"^\s*([^\s:()][^:()]{0,40}?)\s*(\([^)]*\))?\s*:\s*(.+)$")
TIME_SUFFIX_RE = re.compile(r"\s*[-–—]\s*(day|night|dawn|dusk|morning|evening|continuous|later|"
                            r"ngày|đêm|sáng|chiều|tối)\b.*$", re.I)
NOT_SPEAKERS = {"note", "notes", "ghi chú", "sfx", "vo", "v.o.", "music", "nhạc", "transition", "cut to",
                "fade in", "fade out", "camera", "shot", "location", "bối cảnh", "time"}
META_KEYS = {"title": "title", "tiêu đề": "title", "logline": "logline", "hook": "hook",
             "cliffhanger": "cliffhanger", "summary": "summary", "tóm tắt": "summary"}
WORDS_PER_SECOND = 2.5


# ---------------------------------------------------------------- reading files

def read_script_file(path: Path) -> str:
    ext = path.suffix.lower()
    if ext == ".docx":
        import docx  # python-docx
        return "\n".join(p.text for p in docx.Document(str(path)).paragraphs)
    if ext == ".pdf":
        from pypdf import PdfReader
        return "\n".join(page.extract_text() or "" for page in PdfReader(str(path)).pages)
    raw = path.read_bytes()
    for enc in ("utf-8-sig", "utf-16", "cp1258", "latin-1"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def list_script_files(project: str = config.DEFAULT_PROJECT) -> list[Path]:
    folder = config.project_dir(project) / "01_kich_ban"
    return sorted(p for p in folder.iterdir()
                  if p.is_file() and p.suffix.lower() in SCRIPT_EXTS and not p.name.startswith("_"))


# ---------------------------------------------------------------- offline engine

def _is_speaker_line(line: str) -> bool:
    s = line.strip()
    if not s or len(s) > 40 or len(s.split()) > 4:
        return False
    name = re.sub(r"\(.*?\)", "", s).strip()
    return bool(name) and name.isupper() and any(c.isalpha() for c in name) and name.lower() not in NOT_SPEAKERS


def _clean_name(name: str) -> str:
    name = re.sub(r"\(.*?\)", "", name).strip().strip("*_ ")
    return name.title() if name.isupper() else name


def _duration(dialogue: str) -> float:
    words = len(dialogue.split())
    secs = (words / WORDS_PER_SECOND + 1.5) if words else 5
    return float(min(8, max(4, round(secs))))


def _episode_number_from_filename(path: Path | None) -> int:
    if path:
        m = re.search(r"(?:ep|tap|tập|episode)[\s_\-]*0*(\d{1,3})", path.stem, re.I)
        if m:
            return int(m.group(1))
    return 1


def analyze_offline(text: str, source: Path | None = None) -> ScriptAnalysis:
    episodes: list[dict] = []
    warnings: list[str] = []
    ep: dict | None = None
    location = ""
    pending_speaker = ""
    para: list[str] = []
    speakers: dict[str, None] = {}
    locations: dict[str, str] = {}

    preamble: list[str] = []  # text before the first episode header belongs to the first episode

    def new_episode(number: int, title: str = "") -> dict:
        e = {"number": number, "title": title, "logline": "", "summary": "", "hook": "",
             "cliffhanger": "", "script_lines": [] if episodes else preamble, "shots": []}
        episodes.append(e)
        return e

    def current() -> dict:
        nonlocal ep
        if ep is None:
            ep = new_episode(_episode_number_from_filename(source))
        return ep

    def add_shot(action: str = "", speaker: str = "", line: str = "") -> None:
        e = current()
        last = e["shots"][-1] if e["shots"] else None
        # An action about the speaker followed by their line is one shot:
        # "Ethan looks up." + ETHAN: "You thought I was nobody."
        if speaker:
            speakers.setdefault(speaker, None)
        if (line and last and not last["dialogue_en"] and last["location"] == location and last["action"]
                and re.search(rf"\b{re.escape(speaker)}\b", last["action"], re.I)):
            last.update(dialogue_en=line, speaker=speaker)
            if speaker and speaker not in last["characters"]:
                last["characters"].append(speaker)
            return
        chars = [speaker] if speaker else []
        e["shots"].append({"action": action or (f"{speaker} speaks." if speaker else ""), "speaker": speaker,
                           "dialogue_en": line, "characters": chars, "location": location})

    def flush_para() -> None:
        nonlocal para
        if para:
            add_shot(action=" ".join(s.strip() for s in para))
            para = []

    for raw in text.splitlines():
        line = raw.rstrip()
        stripped = line.strip().strip("*_").strip()
        m = EPISODE_RE.match(stripped) if len(stripped) < 120 else None
        if m:
            flush_para()
            num = int(m.group(1))
            if any(e["number"] == num for e in episodes):
                warnings.append(f"Tập {num} xuất hiện hai lần; gộp vào lần đầu.")
                ep = next(e for e in episodes if e["number"] == num)
            else:
                ep = new_episode(num, m.group(2).strip(" :-–—"))
            ep["script_lines"].append(line)
            location, pending_speaker = "", ""
            continue
        if stripped:
            (ep["script_lines"] if ep is not None else preamble).append(line)

        if not stripped:
            flush_para()
            pending_speaker = ""
            continue

        m = META_RE.match(stripped)
        if m:
            flush_para()
            key = META_KEYS[m.group(1).lower()]
            current()[key] = m.group(2).strip()
            continue

        m = SCENE_RE.match(stripped)
        if m:
            flush_para()
            place = (m.group("place") or m.group("place2") or "").strip()
            name = TIME_SUFFIX_RE.sub("", place).strip(" .:-–—") or place or stripped
            name = name.title() if name.isupper() else name
            location = name
            locations.setdefault(name.lower(), name)
            pending_speaker = ""
            continue

        if pending_speaker:
            if stripped.startswith("(") and stripped.endswith(")"):
                continue  # parenthetical
            add_shot(speaker=pending_speaker, line=stripped)
            pending_speaker = ""
            continue

        if _is_speaker_line(stripped):
            flush_para()
            pending_speaker = _clean_name(stripped)
            continue

        m = INLINE_DIALOGUE_RE.match(stripped)
        if m and m.group(1).strip().lower() not in NOT_SPEAKERS and len(m.group(1).split()) <= 3 \
                and m.group(1).strip()[:1].isupper():
            flush_para()
            speaker = _clean_name(m.group(1))
            add_shot(speaker=speaker, line=m.group(3).strip().strip('"“”'))
            continue

        para.append(stripped)
    flush_para()

    if not episodes:
        warnings.append("Không tìm thấy nội dung nào trong kịch bản.")

    # Mentions: a known character name inside an action puts that character in the shot.
    names = list(speakers)
    out_eps: list[EpisodeIn] = []
    for e in sorted(episodes, key=lambda x: x["number"]):
        shots = []
        for i, s in enumerate(e["shots"], start=1):
            for n in names:
                if n not in s["characters"] and re.search(rf"\b{re.escape(n)}\b", s["action"], re.I):
                    s["characters"].append(n)
            shots.append(ShotIn(
                id=f"EP{e['number']:02d}_S{i:02d}", order=i, action=s["action"], dialogue_en=s["dialogue_en"],
                speaker=s["speaker"], camera="medium close-up" if s["dialogue_en"] else "medium shot",
                duration_s=_duration(s["dialogue_en"]), characters=s["characters"],
                location=s["location"]))
        if not shots:
            warnings.append(f"Tập {e['number']} không có shot nào.")
        if shots and not any(s.location for s in shots):
            warnings.append(f"Tập {e['number']}: không thấy dòng bối cảnh (INT./EXT./CẢNH...).")
        total = sum(s.duration_s for s in shots)
        if shots and not 45 <= total <= 120:
            warnings.append(f"Tập {e['number']}: tổng thời lượng ước tính {total:.0f}s (mục tiêu 60-90s).")
        out_eps.append(EpisodeIn(number=e["number"], title=e["title"], logline=e["logline"], summary=e["summary"],
                                 hook=e["hook"], cliffhanger=e["cliffhanger"],
                                 script="\n".join(e["script_lines"]), shots=shots))

    return ScriptAnalysis(engine="offline", episodes=out_eps,
                          characters=[CharacterIn(name=n) for n in names],
                          locations=[LocationIn(name=v) for v in locations.values()],
                          warnings=warnings)


# ---------------------------------------------------------------- persistence

class Locked(Exception):
    """Raised when re-analysis would overwrite approved or already-paid work."""


def save_analysis(conn: sqlite3.Connection, analysis: ScriptAnalysis, source_file: str,
                  project: str = config.DEFAULT_PROJECT) -> list[int]:
    """Write registry entries, episodes and shots. Re-running replaces an episode's draft shots.

    Refuses (Locked) when an episode already passed Gate 1 or any of its shots has a take —
    those represent approved decisions or money already spent.
    """
    proj = registry.get_project(conn, project)
    pid = proj["id"]
    char_code = {c.name.lower(): registry.upsert(conn, "character", pid, c.name, c.canon_description)["code"]
                 for c in analysis.characters}
    loc_id = {l.name.lower(): registry.upsert(conn, "location", pid, l.name, l.canon_description)["id"]
              for l in analysis.locations}

    episode_ids = []
    for e in analysis.episodes:
        row = conn.execute("SELECT * FROM episode WHERE project_id = ? AND number = ?", (pid, e.number)).fetchone()
        if row:
            if row["status"] == "gate1_approved":
                raise Locked(f"Tập {e.number} đã được duyệt ở Cổng 1, không ghi đè.")
            paid = conn.execute("SELECT count(*) FROM take t JOIN shot s ON s.id = t.shot_id WHERE s.episode_id = ?",
                                (row["id"],)).fetchone()[0]
            if paid:
                raise Locked(f"Tập {e.number} đã có video được tạo, không ghi đè.")
            conn.execute("DELETE FROM shot WHERE episode_id = ?", (row["id"],))
            conn.execute("UPDATE episode SET title=?, logline=?, summary=?, script=?, hook=?, cliffhanger=?,"
                         " source_file=?, status='shotlist_ready' WHERE id = ?",
                         (e.title, e.logline, e.summary, e.script, e.hook, e.cliffhanger, source_file, row["id"]))
            eid = row["id"]
        else:
            eid = conn.execute("INSERT INTO episode(project_id, number, title, logline, summary, script, hook,"
                               " cliffhanger, source_file, status) VALUES (?,?,?,?,?,?,?,?,?, 'shotlist_ready')",
                               (pid, e.number, e.title, e.logline, e.summary, e.script, e.hook, e.cliffhanger,
                                source_file)).lastrowid
        for s in e.shots:
            codes = [char_code[c.lower()] for c in s.characters if c.lower() in char_code]
            conn.execute('INSERT INTO shot(id, episode_id, "order", action, camera, dialogue_en, duration_s,'
                         " character_ids, location_id, prop_ids) VALUES (?,?,?,?,?,?,?,?,?,?)",
                         (s.id, eid, s.order, s.action, s.camera, s.dialogue_en, s.duration_s, db.dumps(codes),
                          loc_id.get(s.location.lower()), db.dumps([])))
        episode_ids.append(eid)
        export_shotlist(conn, eid, project)

    for table in ("character", "location"):
        for r in conn.execute(f"SELECT id FROM {table} WHERE project_id = ?", (pid,)).fetchall():
            registry.mirror_to_disk(conn, table, r["id"])
    return episode_ids


def export_shotlist(conn: sqlite3.Connection, episode_id: int, project: str = config.DEFAULT_PROJECT) -> Path:
    """Write 02_shotlist/EPnn_shotlist.json — the shot list JSON deliverable of M1."""
    e = conn.execute("SELECT * FROM episode WHERE id = ?", (episode_id,)).fetchone()
    shots = conn.execute('SELECT s.*, l.code AS location_code FROM shot s LEFT JOIN location l ON l.id = s.location_id'
                         ' WHERE s.episode_id = ? ORDER BY "order"', (episode_id,)).fetchall()
    data = {
        "episode": e["number"], "title": e["title"], "logline": e["logline"], "hook": e["hook"],
        "cliffhanger": e["cliffhanger"], "status": e["status"],
        "shots": [{"id": s["id"], "order": s["order"], "action": s["action"], "camera": s["camera"],
                   "dialogue_en": s["dialogue_en"], "duration_s": s["duration_s"],
                   "character_ids": db.loads(s["character_ids"], []), "location_id": s["location_code"],
                   "prop_ids": db.loads(s["prop_ids"], [])} for s in shots],
    }
    path = config.project_dir(project) / "02_shotlist" / f"EP{e['number']:02d}_shotlist.json"
    import json
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def analyze_file(conn: sqlite3.Connection, path: Path, project: str = config.DEFAULT_PROJECT) -> ScriptAnalysis:
    analysis = analyze_offline(read_script_file(path), source=path)
    save_analysis(conn, analysis, path.name, project)
    return analysis
