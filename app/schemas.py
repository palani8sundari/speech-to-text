from datetime import datetime
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field


class TranscriptionCreate(BaseModel):
    title: Optional[str] = Field(default=None, max_length=200)
    text: str = Field(min_length=1)
    language: str = Field(default="auto", max_length=50)
    engine: str = Field(default="gemini-live", max_length=50)
    duration_seconds: float = Field(default=0.0, ge=0)


class TranscriptionUpdate(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=200)
    text: Optional[str] = Field(default=None, min_length=1)
    language: Optional[str] = Field(default=None, max_length=50)


class TranscriptionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    title: str
    text: str
    language: str
    engine: str
    duration_seconds: float
    word_count: int
    created_at: datetime
    updated_at: datetime


class TranscriptionPage(BaseModel):
    items: list[TranscriptionOut]
    total: int


class Stats(BaseModel):
    total: int
    total_words: int
    total_minutes: float
