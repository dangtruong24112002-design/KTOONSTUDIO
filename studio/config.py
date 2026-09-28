"""Paths, .env and config/models.yaml. The only place that knows where things live on disk."""
from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

import yaml
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
DB_PATH = DATA / "studio.db"
PROJECTS = DATA / "projects"
PROJECT_SUBDIRS = ("00_kho", "01_kich_ban", "02_shotlist", "03_workspace", "04_thanh_pham", "05_so_sach")
DEFAULT_PROJECT = "pilot"

load_dotenv(ROOT / ".env")


@lru_cache
def models_cfg() -> dict:
    return yaml.safe_load((ROOT / "config" / "models.yaml").read_text(encoding="utf-8"))


def budget_limits() -> dict[str, float]:
    b = models_cfg()["budgets"]
    return {
        "per_episode": float(os.getenv("BUDGET_PER_EPISODE") or b["per_episode"]),
        "per_month": float(os.getenv("BUDGET_PER_MONTH") or b["per_month"]),
    }


def project_dir(name: str) -> Path:
    d = PROJECTS / name
    for sub in PROJECT_SUBDIRS:
        (d / sub).mkdir(parents=True, exist_ok=True)
    return d
