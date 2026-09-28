"""Asset registry: one row per character / location / prop, reused across every episode.

Codes are stable: characters NV.A, NV.B ...; locations BC.1, BC.2 ...; props P.1, P.2 ...
Matching is by name (case-insensitive), so re-analysing a script never creates duplicates.
Canon descriptions are mirrored to data/projects/<name>/00_kho/<code>.txt for the owner.
"""
from __future__ import annotations

import sqlite3
import string

from studio import config
from studio.core import db

TABLES = {"character": "NV", "location": "BC", "prop": "P"}


def get_project(conn: sqlite3.Connection, name: str = config.DEFAULT_PROJECT) -> sqlite3.Row:
    conn.execute("INSERT OR IGNORE INTO project(name) VALUES (?)", (name,))
    config.project_dir(name)
    return conn.execute("SELECT * FROM project WHERE name = ?", (name,)).fetchone()


def _next_code(conn: sqlite3.Connection, table: str, project_id: int) -> str:
    n = conn.execute(f"SELECT count(*) FROM {table} WHERE project_id = ?", (project_id,)).fetchone()[0]
    prefix = TABLES[table]
    if table == "character":
        # NV.A .. NV.Z, then NV.AA, NV.AB ...
        letters = string.ascii_uppercase
        tag = letters[n] if n < 26 else letters[n // 26 - 1] + letters[n % 26]
        return f"{prefix}.{tag}"
    return f"{prefix}.{n + 1}"


def find(conn: sqlite3.Connection, table: str, project_id: int, name: str) -> sqlite3.Row | None:
    return conn.execute(f"SELECT * FROM {table} WHERE project_id = ? AND lower(name) = lower(?)",
                        (project_id, name.strip())).fetchone()


def upsert(conn: sqlite3.Connection, table: str, project_id: int, name: str, canon_description: str = "") -> sqlite3.Row:
    """Return the existing asset with this name, or create it. Never overwrites an owner's description."""
    assert table in TABLES
    row = find(conn, table, project_id, name)
    if row:
        if canon_description and not row["canon_description"]:
            conn.execute(f"UPDATE {table} SET canon_description = ? WHERE id = ?", (canon_description, row["id"]))
        return find(conn, table, project_id, name)
    code = _next_code(conn, table, project_id)
    conn.execute(f"INSERT INTO {table}(project_id, code, name, canon_description) VALUES (?,?,?,?)",
                 (project_id, code, name.strip(), canon_description))
    return find(conn, table, project_id, name)


def update(conn: sqlite3.Connection, table: str, asset_id: int, fields: dict) -> None:
    """Owner edit. Bumps version when the description changes so later work can notice."""
    allowed = {"name", "canon_description", "rules", "prompt_block", "status"}
    fields = {k: v for k, v in fields.items() if k in allowed}
    if table != "character":
        fields.pop("rules", None)
    if table == "prop":
        fields.pop("prompt_block", None)
    if not fields:
        return
    old = conn.execute(f"SELECT * FROM {table} WHERE id = ?", (asset_id,)).fetchone()
    sets = ", ".join(f"{k} = ?" for k in fields)
    conn.execute(f"UPDATE {table} SET {sets} WHERE id = ?", (*fields.values(), asset_id))
    if table != "prop" and fields.get("canon_description", old["canon_description"]) != old["canon_description"]:
        conn.execute(f"UPDATE {table} SET version = version + 1 WHERE id = ?", (asset_id,))
    mirror_to_disk(conn, table, asset_id)


def mirror_to_disk(conn: sqlite3.Connection, table: str, asset_id: int) -> None:
    row = conn.execute(f"SELECT a.*, p.name AS project FROM {table} a JOIN project p ON p.id = a.project_id"
                       f" WHERE a.id = ?", (asset_id,)).fetchone()
    lines = [f"{row['code']} — {row['name']}", "", row["canon_description"] or "(chưa có mô tả)"]
    if table == "character" and row["rules"]:
        lines += ["", "Luật riêng:", row["rules"]]
    path = config.project_dir(row["project"]) / "00_kho" / f"{row['code']}.txt"
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def list_all(conn: sqlite3.Connection, project_id: int) -> dict[str, list[sqlite3.Row]]:
    return {t: conn.execute(f"SELECT * FROM {t} WHERE project_id = ? ORDER BY id", (project_id,)).fetchall()
            for t in TABLES}


def usage_counts(conn: sqlite3.Connection, project_id: int) -> dict[str, int]:
    """How many shots reference each character code / location id. Shown in the registry screen."""
    counts: dict[str, int] = {}
    rows = conn.execute("SELECT s.character_ids, s.location_id FROM shot s JOIN episode e ON e.id = s.episode_id"
                        " WHERE e.project_id = ?", (project_id,)).fetchall()
    for r in rows:
        for code in db.loads(r["character_ids"], []):
            counts[code] = counts.get(code, 0) + 1
        if r["location_id"]:
            key = f"loc:{r['location_id']}"
            counts[key] = counts.get(key, 0) + 1
    return counts
