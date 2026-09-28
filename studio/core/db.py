"""SQLite schema (BRIEF section 4) and connection helper. SQLite is the only source of truth.

List-valued columns (lock_images, character_ids, ...) are stored as JSON text.
"""
from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from studio import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS project (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    style_bible TEXT NOT NULL DEFAULT '',
    rules_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS character (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES project(id),
    code TEXT NOT NULL,                 -- "NV.A"
    name TEXT NOT NULL,
    canon_description TEXT NOT NULL DEFAULT '',
    lock_images TEXT NOT NULL DEFAULT '[]',
    prompt_block TEXT NOT NULL DEFAULT '',
    rules TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft',
    version INTEGER NOT NULL DEFAULT 1,
    UNIQUE (project_id, code)
);
CREATE TABLE IF NOT EXISTS location (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES project(id),
    code TEXT NOT NULL,                 -- "BC.1"
    name TEXT NOT NULL DEFAULT '',
    canon_description TEXT NOT NULL DEFAULT '',
    lock_images TEXT NOT NULL DEFAULT '[]',
    prompt_block TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft',
    version INTEGER NOT NULL DEFAULT 1,
    UNIQUE (project_id, code)
);
CREATE TABLE IF NOT EXISTS prop (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES project(id),
    code TEXT NOT NULL,                 -- "P.1"
    name TEXT NOT NULL DEFAULT '',
    canon_description TEXT NOT NULL DEFAULT '',
    lock_images TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'draft',
    UNIQUE (project_id, code)
);
CREATE TABLE IF NOT EXISTS episode (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES project(id),
    number INTEGER NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    logline TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    script TEXT NOT NULL DEFAULT '',
    hook TEXT NOT NULL DEFAULT '',
    cliffhanger TEXT NOT NULL DEFAULT '',
    source_file TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft',
    UNIQUE (project_id, number)
);
CREATE TABLE IF NOT EXISTS shot (
    id TEXT PRIMARY KEY,                -- "EP01_S03"
    episode_id INTEGER NOT NULL REFERENCES episode(id),
    "order" INTEGER NOT NULL,
    action TEXT NOT NULL DEFAULT '',
    camera TEXT NOT NULL DEFAULT '',
    dialogue_en TEXT NOT NULL DEFAULT '',
    duration_s REAL NOT NULL DEFAULT 5,
    character_ids TEXT NOT NULL DEFAULT '[]',
    location_id INTEGER REFERENCES location(id),
    prop_ids TEXT NOT NULL DEFAULT '[]',
    keyframe_image_id INTEGER REFERENCES image(id),
    prompt_text TEXT NOT NULL DEFAULT '',
    negative_prompt TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft',
    chosen_take_id TEXT,
    cost_total REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS take (
    id TEXT PRIMARY KEY,
    shot_id TEXT NOT NULL REFERENCES shot(id),
    model TEXT NOT NULL,
    params_json TEXT NOT NULL DEFAULT '{}',
    file_path TEXT,
    qc_scores_json TEXT NOT NULL DEFAULT '{}',
    verdict TEXT,
    reject_reason_enum TEXT,
    cost_usd REAL NOT NULL DEFAULT 0,
    latency_s REAL
);
CREATE TABLE IF NOT EXISTS image (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,                 -- character_lock | location_lock | keyframe | ...
    owner_ref TEXT NOT NULL,            -- "NV.A", "BC.1", "EP01_S03"
    file_path TEXT NOT NULL,
    prompt TEXT NOT NULL DEFAULT '',
    scores_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'candidate'
);
CREATE TABLE IF NOT EXISTS generation_log (
    id TEXT PRIMARY KEY,                -- provider request/prediction id
    ts TEXT NOT NULL,
    kind TEXT NOT NULL,                 -- image | video | llm | tts | ...
    model TEXT NOT NULL,
    request_json TEXT NOT NULL DEFAULT '{}',
    response_json TEXT NOT NULL DEFAULT '{}',
    cost_usd REAL NOT NULL DEFAULT 0,
    ok INTEGER NOT NULL,
    error TEXT,
    episode_id INTEGER REFERENCES episode(id)
);
CREATE TABLE IF NOT EXISTS budget (
    scope TEXT PRIMARY KEY,             -- "month:2026-09", "episode:3", "m0"
    limit_usd REAL NOT NULL,
    spent_usd REAL NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS approval (
    id INTEGER PRIMARY KEY,
    gate INTEGER NOT NULL,              -- 1..4
    target_id TEXT NOT NULL,
    status TEXT NOT NULL,               -- approved | rejected
    note TEXT NOT NULL DEFAULT '',
    ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_shot_episode ON shot(episode_id, "order");
CREATE INDEX IF NOT EXISTS ix_take_shot ON take(shot_id);
CREATE INDEX IF NOT EXISTS ix_log_ts ON generation_log(ts);
"""


def connect(path: Path | None = None) -> sqlite3.Connection:
    path = path or config.DB_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def init(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    conn.commit()


@contextmanager
def session(path: Path | None = None) -> Iterator[sqlite3.Connection]:
    """One connection per unit of work; commits on success, rolls back on error."""
    conn = connect(path)
    try:
        init(conn)
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def dumps(v) -> str:
    return json.dumps(v, ensure_ascii=False)


def loads(s: str | None, default=None):
    return json.loads(s) if s else default
