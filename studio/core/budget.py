"""Line producer: the money ledger. Every paid call goes through record_cost()."""
from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path

from studio import config
from studio.core import db


def month_scope(ts: str | None = None) -> str:
    return "month:" + (ts or time.strftime("%Y-%m-%d"))[:7]


def ensure_scopes(conn: sqlite3.Connection) -> None:
    limits = config.budget_limits()
    conn.execute("INSERT OR IGNORE INTO budget(scope, limit_usd) VALUES (?, ?)", (month_scope(), limits["per_month"]))
    conn.execute("INSERT OR IGNORE INTO budget(scope, limit_usd) VALUES ('m0', ?)",
                 (float(config.models_cfg()["budgets"]["m0_test"]),))


def record_cost(conn: sqlite3.Connection, *, id: str, ts: str, kind: str, model: str, cost_usd: float,
                ok: bool, request: dict | None = None, response: dict | None = None, error: str | None = None,
                episode_id: int | None = None, extra_scopes: tuple[str, ...] = ()) -> bool:
    """Write one generation_log row and add its cost to every matching budget scope.

    Idempotent on id: logging the same provider request twice never double-counts money.
    Returns False when the row already existed.
    """
    cur = conn.execute(
        "INSERT OR IGNORE INTO generation_log(id, ts, kind, model, request_json, response_json, cost_usd, ok, error, episode_id)"
        " VALUES (?,?,?,?,?,?,?,?,?,?)",
        (id, ts, kind, model, db.dumps(request or {}), db.dumps(response or {}), round(cost_usd, 6), int(ok), error, episode_id),
    )
    if cur.rowcount == 0:
        return False
    limits = config.budget_limits()
    scopes = [(month_scope(ts), limits["per_month"])]
    if episode_id is not None:
        scopes.append((f"episode:{episode_id}", limits["per_episode"]))
    scopes += [(s, 0.0) for s in extra_scopes]
    for scope, limit in scopes:
        conn.execute("INSERT OR IGNORE INTO budget(scope, limit_usd) VALUES (?, ?)", (scope, limit))
        conn.execute("UPDATE budget SET spent_usd = round(spent_usd + ?, 6) WHERE scope = ?", (cost_usd, scope))
    return True


def can_spend(conn: sqlite3.Connection, estimate_usd: float, episode_id: int | None = None) -> tuple[bool, str]:
    """Check the month cap (and the episode cap) before a paid call."""
    ensure_scopes(conn)
    checks = [month_scope()] + ([f"episode:{episode_id}"] if episode_id is not None else [])
    for scope in checks:
        row = conn.execute("SELECT limit_usd, spent_usd FROM budget WHERE scope = ?", (scope,)).fetchone()
        if row and row["spent_usd"] + estimate_usd > row["limit_usd"]:
            return False, f"{scope}: đã chi ${row['spent_usd']:.2f}, trần ${row['limit_usd']:.2f}"
    return True, ""


def summary(conn: sqlite3.Connection) -> dict:
    ensure_scopes(conn)
    total = conn.execute("SELECT coalesce(sum(cost_usd), 0) AS s, count(*) AS n FROM generation_log").fetchone()
    m = conn.execute("SELECT limit_usd, spent_usd FROM budget WHERE scope = ?", (month_scope(),)).fetchone()
    return {
        "total": round(total["s"], 4),
        "calls": total["n"],
        "month": round(m["spent_usd"], 4),
        "month_limit": m["limit_usd"],
        "month_pct": min(100, round(100 * m["spent_usd"] / m["limit_usd"], 1)) if m["limit_usd"] else 0,
        "per_episode_limit": config.budget_limits()["per_episode"],
    }


def import_m0_log(conn: sqlite3.Connection, path: Path | None = None) -> int:
    """Bring the money spent in the M0 smoke test into the ledger (idempotent)."""
    path = path or (config.DATA / "m0_log.jsonl")
    if not path.exists():
        return 0
    rows = [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]
    # Balance snapshots measure what was really deducted for a step group (e.g. "t1").
    # Where one exists, it replaces the list price, split evenly over that group's billed calls.
    real: dict[str, float] = {}
    for r in rows:
        if r.get("step", "").endswith("_balance") and "delta" in r:
            group = r["step"].split("_")[0]
            billed = [x for x in rows if "model" in x and x["step"].split("_")[0] == group and x.get("cost_usd")]
            if billed:
                real[group] = r["delta"] / len(billed)
    n = 0
    for r in rows:
        if "model" not in r:  # balance snapshots etc.
            continue
        rid = r.get("prediction_id") or f"m0:{r['step']}:{r['ts']}"
        cost = float(r.get("cost_usd", 0))
        if cost and r["step"].split("_")[0] in real:
            cost = real[r["step"].split("_")[0]]
        n += record_cost(conn, id=rid, ts=r["ts"], kind="image" if "seedream" in r["model"] else "video",
                         model=r["model"], cost_usd=cost, ok=bool(r.get("ok")),
                         request=r.get("params"), response={"status": r.get("status"), "output_url": r.get("output_url")},
                         error=r.get("error") or None, extra_scopes=("m0",))
    return n
