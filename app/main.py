import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Query, Response, WebSocket
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from .db import Transcription, get_db, init_db
from .live import MODEL, gemini_configured, handle_live_socket
from .schemas import Stats, TranscriptionCreate, TranscriptionOut, TranscriptionPage, TranscriptionUpdate

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
STATIC_DIR = Path(__file__).resolve().parent.parent / "static"


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    yield


app = FastAPI(title="Vaani — Real-time Speech to Text", lifespan=lifespan)


def _word_count(text: str) -> int:
    return len(text.split())


def _auto_title(text: str) -> str:
    words = text.split()
    title = " ".join(words[:8])
    return title + ("…" if len(words) > 8 else "")


# ---------- Health / config ----------

@app.get("/api/health")
def health():
    return {"status": "ok", "gemini_configured": gemini_configured(), "model": MODEL}


# ---------- CRUD ----------

@app.get("/api/transcriptions", response_model=TranscriptionPage)
def list_transcriptions(
    q: str = Query(default="", max_length=200),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
):
    stmt = select(Transcription)
    if q:
        like = f"%{q}%"
        stmt = stmt.where(or_(Transcription.title.ilike(like), Transcription.text.ilike(like)))
    total = db.scalar(select(func.count()).select_from(stmt.subquery())) or 0
    items = db.scalars(
        stmt.order_by(Transcription.created_at.desc(), Transcription.id.desc()).limit(limit).offset(offset)
    ).all()
    return {"items": items, "total": total}


@app.get("/api/transcriptions/stats", response_model=Stats)
def stats(db: Session = Depends(get_db)):
    total, words, seconds = db.execute(
        select(
            func.count(Transcription.id),
            func.coalesce(func.sum(Transcription.word_count), 0),
            func.coalesce(func.sum(Transcription.duration_seconds), 0.0),
        )
    ).one()
    return {"total": total, "total_words": int(words), "total_minutes": round(float(seconds) / 60, 1)}


@app.post("/api/transcriptions", response_model=TranscriptionOut, status_code=201)
def create_transcription(payload: TranscriptionCreate, db: Session = Depends(get_db)):
    text = payload.text.strip()
    if not text:
        raise HTTPException(422, "Text cannot be empty")
    row = Transcription(
        title=(payload.title or "").strip() or _auto_title(text),
        text=text,
        language=payload.language,
        engine=payload.engine,
        duration_seconds=payload.duration_seconds,
        word_count=_word_count(text),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def _get_or_404(db: Session, item_id: int) -> Transcription:
    row = db.get(Transcription, item_id)
    if not row:
        raise HTTPException(404, "Transcription not found")
    return row


@app.get("/api/transcriptions/{item_id}", response_model=TranscriptionOut)
def get_transcription(item_id: int, db: Session = Depends(get_db)):
    return _get_or_404(db, item_id)


@app.put("/api/transcriptions/{item_id}", response_model=TranscriptionOut)
def update_transcription(item_id: int, payload: TranscriptionUpdate, db: Session = Depends(get_db)):
    row = _get_or_404(db, item_id)
    if payload.title is not None:
        row.title = payload.title.strip()
    if payload.text is not None:
        row.text = payload.text.strip()
        row.word_count = _word_count(row.text)
    if payload.language is not None:
        row.language = payload.language
    db.commit()
    db.refresh(row)
    return row


@app.delete("/api/transcriptions/{item_id}", status_code=204)
def delete_transcription(item_id: int, db: Session = Depends(get_db)):
    row = _get_or_404(db, item_id)
    db.delete(row)
    db.commit()
    return Response(status_code=204)


# ---------- Real-time transcription ----------

@app.websocket("/ws/transcribe")
async def ws_transcribe(ws: WebSocket, language: str = "auto"):
    await handle_live_socket(ws, language)


# ---------- Frontend ----------

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC_DIR / "index.html")
