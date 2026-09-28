"""Pydantic schemas. Every agent's JSON output is validated against these before touching the DB."""
from __future__ import annotations

import re
from enum import Enum

from pydantic import BaseModel, Field, field_validator

SHOT_ID = re.compile(r"^EP\d{2,3}_S\d{2,3}$")


class RejectReason(str, Enum):
    """Closed list — training data for the future brain. Add values, never rename them."""
    face_mismatch = "face_mismatch"
    wrong_location = "wrong_location"
    wardrobe_continuity = "wardrobe_continuity"
    prop_continuity = "prop_continuity"
    hand_defect = "hand_defect"
    body_defect = "body_defect"
    burned_subtitles = "burned_subtitles"
    bad_lipsync = "bad_lipsync"
    bad_audio = "bad_audio"
    wrong_action = "wrong_action"
    wrong_camera = "wrong_camera"
    artifact = "artifact"
    black_or_frozen = "black_or_frozen"
    moderation_block = "moderation_block"
    owner_note = "owner_note"


class CharacterIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    canon_description: str = ""
    rules: str = ""


class LocationIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    canon_description: str = ""


class ShotIn(BaseModel):
    id: str
    order: int = Field(ge=1)
    action: str = ""
    camera: str = ""
    dialogue_en: str = ""
    speaker: str = ""
    duration_s: float = Field(default=5, ge=4, le=15)
    characters: list[str] = []          # character names, resolved to registry codes on save
    location: str = ""                  # location name, resolved to a registry code on save
    props: list[str] = []

    @field_validator("id")
    @classmethod
    def _id_shape(cls, v: str) -> str:
        if not SHOT_ID.match(v):
            raise ValueError(f"shot id must look like EP01_S03, got {v!r}")
        return v


class EpisodeIn(BaseModel):
    number: int = Field(ge=1, le=999)
    title: str = ""
    logline: str = ""
    summary: str = ""
    hook: str = ""
    cliffhanger: str = ""
    script: str = ""
    shots: list[ShotIn] = []

    @field_validator("shots")
    @classmethod
    def _unique_ids(cls, v: list[ShotIn]) -> list[ShotIn]:
        ids = [s.id for s in v]
        if len(ids) != len(set(ids)):
            raise ValueError("duplicate shot ids")
        return v


class ScriptAnalysis(BaseModel):
    """Output of Role 1 (Development) for one script file."""
    engine: str                         # "offline" (free rules) or an LLM model id
    episodes: list[EpisodeIn]
    characters: list[CharacterIn] = []
    locations: list[LocationIn] = []
    warnings: list[str] = []
