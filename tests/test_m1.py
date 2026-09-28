"""Tests where they save money: cost math, schema validation, re-run safety."""
import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from studio.core import budget, db
from studio.core.models import EpisodeIn, ShotIn
from studio.roles import development

SAMPLE = Path(__file__).parent / "sample_script.txt"


@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setattr("studio.config.PROJECTS", tmp_path / "projects")
    c = db.connect(tmp_path / "t.db")
    db.init(c)
    yield c
    c.close()


def test_record_cost_is_idempotent_and_hits_every_scope(conn):
    kw = dict(id="pred-1", ts="2026-09-27T10:00:00", kind="image", model="m", cost_usd=0.027, ok=True, episode_id=None)
    assert budget.record_cost(conn, **kw, extra_scopes=("m0",))
    assert not budget.record_cost(conn, **kw, extra_scopes=("m0",))  # same provider id: no double count
    spent = dict(conn.execute("SELECT scope, spent_usd FROM budget").fetchall())
    assert spent["month:2026-09"] == pytest.approx(0.027)
    assert spent["m0"] == pytest.approx(0.027)


def test_can_spend_blocks_at_month_cap(conn, monkeypatch):
    monkeypatch.setattr("studio.config.budget_limits", lambda: {"per_month": 1.0, "per_episode": 40.0})
    budget.record_cost(conn, id="a", ts=budget.month_scope()[6:] + "-01T00:00:00", kind="video", model="m",
                       cost_usd=0.9, ok=True)
    assert budget.can_spend(conn, 0.05)[0]
    assert not budget.can_spend(conn, 0.2)[0]


def test_m0_import_uses_measured_balance_delta(conn, tmp_path):
    log = tmp_path / "m0.jsonl"
    rows = [
        {"ts": "2026-09-27T16:33:00", "step": "t1_a", "model": "bytedance/seedream-v5.0-flash", "prediction_id": "p1", "ok": True, "cost_usd": 0.027},
        {"ts": "2026-09-27T16:33:30", "step": "t1_b", "model": "bytedance/seedream-v5.0-flash", "prediction_id": "p2", "ok": True, "cost_usd": 0.027},
        {"ts": "2026-09-27T16:33:41", "step": "t1_balance", "before": 1.0, "after": 0.9514, "delta": 0.0486, "ok": True, "cost_usd": 0},
    ]
    log.write_text("\n".join(json.dumps(r) for r in rows), encoding="utf-8")
    assert budget.import_m0_log(conn, log) == 2
    assert budget.import_m0_log(conn, log) == 0
    total = conn.execute("SELECT sum(cost_usd) FROM generation_log").fetchone()[0]
    assert total == pytest.approx(0.0486)


def test_shot_schema_rejects_bad_ids_and_durations():
    with pytest.raises(ValidationError):
        ShotIn(id="shot3", order=1)
    with pytest.raises(ValidationError):
        ShotIn(id="EP01_S01", order=1, duration_s=40)
    with pytest.raises(ValidationError):
        EpisodeIn(number=1, shots=[ShotIn(id="EP01_S01", order=1), ShotIn(id="EP01_S01", order=2)])


def test_offline_parser_on_sample():
    a = development.analyze_offline(development.read_script_file(SAMPLE))
    assert [e.number for e in a.episodes] == [1, 2]
    assert {c.name for c in a.characters} == {"Vanessa", "Ethan", "Lawyer"}
    ep1 = a.episodes[0]
    assert ep1.hook.startswith("Ethan is thrown out")
    assert any(s.dialogue_en == "I'm just doing my job, ma'am." and s.action == "Ethan lowers his eyes." for s in ep1.shots)
    assert all(4 <= s.duration_s <= 8 for e in a.episodes for s in e.shots)


def test_reanalysis_replaces_drafts_but_never_approved_work(conn):
    a = development.analyze_offline(development.read_script_file(SAMPLE))
    development.save_analysis(conn, a, SAMPLE.name)
    development.save_analysis(conn, a, SAMPLE.name)  # re-run: no duplicates
    assert conn.execute("SELECT count(*) FROM character").fetchone()[0] == 3
    assert conn.execute("SELECT count(*) FROM shot").fetchone()[0] == sum(len(e.shots) for e in a.episodes)
    conn.execute("UPDATE episode SET status = 'gate1_approved' WHERE number = 1")
    with pytest.raises(development.Locked):
        development.save_analysis(conn, a, SAMPLE.name)
